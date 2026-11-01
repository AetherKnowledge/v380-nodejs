// import beamcoder = require('beamcoder');
import ffmpeg = require('fluent-ffmpeg');
import express = require('express');
import { isIP, Socket } from 'net';
import * as t from 'typebase';
import * as stream from 'stream';
import * as crypto from 'crypto';
import { readCameraBytes } from './socket';
import { LiveFlv } from './live';

interface IStreamInfo {
	id: number;
	stream: stream.PassThrough;
	hasIframe: boolean;
	_coll: IStreamInfo[];
}

const streamStruct = t.Struct.define([
	['type', t.ui8],
	['index', t.ui8],
	['totalFrame', t.ui16],
	['curFrame', t.ui16],
	['len', t.ui16],
]);

export function createCameraStream(name: string, audioBaseUrl: string, audioOnly = false) {
	const log = (...args: unknown[]) => console.log(`[${name}]`, ...args);
	const error = (...args: unknown[]) => console.error(`[${name}]`, ...args);
	let curId = 0;
	let width = 0;
	let height = 0;
	let fps = 0;
	let mediaKey: Buffer | undefined;
	const app = express.Router();
	let initialized = false;
	const live = new LiveFlv(audioOnly);
	const audioLive = audioOnly ? live : new LiveFlv(true);

	// Cache a complete, bounded chain from a keyframe through the latest P-frame.
	const MAX_CACHED_PFRAMES = 200;
	const MAX_VIDEO_BUFFER_BYTES = 8 * 1024 * 1024;
	let pFrame: Buffer[] = [];
	let iFrame: Buffer | undefined;
	let videoCacheBytes = 0;

	function init(packet: any, auth?: { version: number; authTicket: number }) {
		reset();
		width = packet.width;
		height = packet.height;
		fps = packet.maybeFps;
		mediaKey = undefined;
		if (auth && auth.version > 30) {
			if (packet.maybeFps !== 20) {
				throw new Error(`Unsupported encrypted-media communication version ${packet.maybeFps}`);
			}
			mediaKey = Buffer.from('000000005c79142c46238161f00d8082', 'hex');
			mediaKey.writeUInt32LE(auth.authTicket, 0);
		}
		log(audioOnly ? 'Audio-only output (camera transport still includes video)' : mediaKey ? `${width}x${height} (camera timestamps)` : `${width}x${height} @ ${fps} fps`);

		initialized = true;
	}

	function reset() {
		videoPacketQueue = [];
		audioPacketQueue = [];
		iFrame = undefined;
		pFrame = [];
		videoCacheBytes = 0;
		live.reset();
		if (audioLive !== live) audioLive.reset();
		// FFmpeg inputs cannot cross sessions with new codec headers/timestamps.
		for (const client of [...vidStreams, ...audStreams]) removeStream(client);
	}

	function decodeVideoFrame(frame: Buffer): Buffer {
		if (!mediaKey) {
			return frame;
		}
		if (frame.length < 16) {
			throw new Error('Encrypted video frame is missing its 16-byte header');
		}
		const video = Buffer.from(frame.subarray(16));
		const decipher = crypto.createDecipheriv('aes-128-ecb', mediaKey, null);
		decipher.setAutoPadding(false);
		// Firmware v31 encrypts 64 bytes out of every 80; remaining bytes stay clear.
		for (let offset = 0; offset + 64 <= video.length; offset += 80) {
			decipher.update(video.subarray(offset, offset + 64)).copy(video, offset);
		}
		decipher.final();
		return video;
	}

	function frameTimestamp(frame: Buffer): number {
		if (frame.length < 16) throw new Error('Missing camera media header');
		const timestamp = frame.readUInt32LE(8) + frame.readUInt32LE(12) * 0x100000000;
		if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid camera media timestamp');
		return timestamp;
	}

	function decodeAudioFrame(frame: Buffer): Buffer {
		if (!mediaKey) {
			return frame.subarray(20);
		}
		// The 16-byte frame header is clear; the ADPCM block header is encrypted too.
		const audio = Buffer.from(frame.subarray(16));
		if (!audio.length || audio.length % 256 !== 0) {
			throw new Error('Expected encrypted 256-byte IMA ADPCM audio blocks');
		}
		const decipher = crypto.createDecipheriv('aes-128-ecb', mediaKey, null);
		decipher.setAutoPadding(false);
		const decoded = Buffer.concat([decipher.update(audio), decipher.final()]);
		for (let offset = 0; offset < decoded.length; offset += 256) {
			if (decoded[offset + 2] > 88 || decoded[offset + 3] !== 0) {
				throw new Error('Invalid decrypted IMA ADPCM audio block header');
			}
		}
		return decoded;
	}

	function createAudioWaveHeader(): Buffer {
		// Streaming mono IMA WAV: 256-byte blocks hold 505 samples at 8000 Hz.
		const header = Buffer.alloc(60);
		header.write('RIFF', 0);
		header.writeUInt32LE(0xffffffff, 4);
		header.write('WAVEfmt ', 8);
		header.writeUInt32LE(20, 16);
		header.writeUInt16LE(0x11, 20);
		header.writeUInt16LE(1, 22);
		header.writeUInt32LE(8000, 24);
		header.writeUInt32LE(Math.floor(8000 * 256 / 505), 28);
		header.writeUInt16LE(256, 32);
		header.writeUInt16LE(4, 34);
		header.writeUInt16LE(2, 36);
		header.writeUInt16LE(505, 38);
		header.write('fact', 40);
		header.writeUInt32LE(4, 44);
		header.writeUInt32LE(0xffffffff, 48);
		header.write('data', 52);
		header.writeUInt32LE(0xffffffff, 56);
		return header;
	}

	const vidStreams: IStreamInfo[] = [];
	const audStreams: IStreamInfo[] = [];
	function createStream(collections: IStreamInfo[]) {
		const id = ++curId;
		const strm = new stream.PassThrough();
		(strm as any)._id = id;

		const info: IStreamInfo = {
			hasIframe: false,
			id,
			stream: strm,
			_coll: collections,
		};

		collections.push(info);
		return info;
	}

	function removeStream(strm: IStreamInfo) {
		const i = strm._coll.indexOf(strm);
		if (i >= 0) {
			strm._coll.splice(i, 1);
			strm.stream.destroy();
		}
	}

	function writeVideo(frame: Buffer, keyframe: boolean) {
		for (const client of [...vidStreams]) {
			if (client.stream.writableLength + frame.length > MAX_VIDEO_BUFFER_BYTES) {
				removeStream(client);
				continue;
			}
			if (keyframe) {
				client.hasIframe = true;
			}
			if (client.hasIframe) {
				client.stream.write(frame);
			}
		}
	}

	let videoPacketQueue: Buffer[] = [];
	let audioPacketQueue: Buffer[] = [];
	async function handleStream(packet: Buffer, sock: Socket) {
		const streamPacket = streamStruct.unpack(new t.Pointer(packet, 1));

		if (!streamPacket.len || streamPacket.len > 500 || !streamPacket.totalFrame || streamPacket.curFrame >= streamPacket.totalFrame) {
			throw new Error('Invalid camera frame fragment header');
		}
		const streamData = await readCameraBytes(sock, streamPacket.len);
		// Drain transport bytes without decrypting, assembling, or parsing video.
		if (audioOnly && (streamPacket.type === 0 || streamPacket.type === 1)) return;

		switch (streamPacket.type) {
			case 0x00: // Probably I-frame
				videoPacketQueue.push(streamData);
				if (streamPacket.curFrame === streamPacket.totalFrame - 1) {
					// log('i frame');
					const frame = Buffer.concat(videoPacketQueue);
					const concatBuff = decodeVideoFrame(frame);
					if (mediaKey) live.video(concatBuff, frameTimestamp(frame));
					iFrame = concatBuff;
					pFrame = [];
					videoCacheBytes = concatBuff.length;
					if (videoCacheBytes > MAX_VIDEO_BUFFER_BYTES) {
						iFrame = undefined;
					}
					writeVideo(concatBuff, true);
					videoPacketQueue = [];
				}
				break;
			case 0x01: // Probably P-frame
				// Video
				videoPacketQueue.push(streamData);
				if (streamPacket.curFrame === streamPacket.totalFrame - 1) {
					// log('p frame');
					const frame = Buffer.concat(videoPacketQueue);
					const concatBuff = decodeVideoFrame(frame);
					if (mediaKey) live.video(concatBuff, frameTimestamp(frame));
					if (iFrame) {
						videoCacheBytes += concatBuff.length;
						if (pFrame.length >= MAX_CACHED_PFRAMES || videoCacheBytes > MAX_VIDEO_BUFFER_BYTES) {
							// A partial reference chain cannot be decoded. Wait for the next keyframe.
							iFrame = undefined;
							pFrame = [];
							videoCacheBytes = 0;
						} else {
							pFrame.push(concatBuff);
						}
					}
					writeVideo(concatBuff, false);
					videoPacketQueue = [];
				}
				break;

			case 0x16:
				// Audio
				audioPacketQueue.push(streamData);
				if (streamPacket.curFrame === streamPacket.totalFrame - 1) {
					const frame = Buffer.concat(audioPacketQueue);
					const concatBuff = decodeAudioFrame(frame);
					if (mediaKey) {
						const timestamp = frameTimestamp(frame);
						live.audio(concatBuff, timestamp);
						if (audioLive !== live) audioLive.audio(concatBuff, timestamp);
					}
					for (const s of audStreams) {
						s.stream.write(concatBuff);
					}
					audioPacketQueue = [];
				}
				break;

			default:
				log('unknown type', streamPacket.type);
		}
	}

	function serveLive(req: express.Request, res: express.Response) {
		if (!initialized) {
			res.status(503);
			res.setHeader('Retry-After', '1');
			res.end('Camera not connected');
			return;
		}
		if (!mediaKey) {
			res.redirect(`/${name}/${audioOnly ? 'audio' : 'video'}/stream.flv`);
			return;
		}
		res.contentType('flv');
		res.setHeader('Cache-Control', 'no-store');
		res.socket?.setNoDelay(true);
		live.attach(res);
	}

	app.get('/audio.flv', (req, res) => {
		if (!initialized) {
			res.status(503).setHeader('Retry-After', '1');
			res.end('Camera not connected');
			return;
		}
		if (!mediaKey) { res.redirect(`/${name}/audio/stream.flv`); return; }
		res.contentType('flv');
		res.setHeader('Cache-Control', 'no-store');
		res.socket?.setNoDelay(true);
		audioLive.attach(res);
	});

	app.get('/audio/:filename', (req, res) => {
		const newStream = createStream(audStreams);
		res.once('close', () => removeStream(newStream));
		newStream.stream.once('close', () => res.destroy());
		if (mediaKey) {
			newStream.stream.write(createAudioWaveHeader());
			if (req.params.filename === 'stream.wav') {
				res.contentType('audio/wav');
				newStream.stream.pipe(res);
				return;
			}
		}

		res.contentType('flv');
		const f = ffmpeg()
			.format('flv')
			.input(newStream.stream);
		if (mediaKey) {
			f.withInputOption(['-f wav', '-ignore_length 1', '-max_size 256', '-probesize 32', '-analyzeduration 100000']);
		} else {
			f.withInputOption(['-f s16le', '-ar 8000', '-acodec adpcm_ima_ws', '-ac 1']);
		}
		f
			.noVideo()
			.audioBitrate('32k')
			.audioCodec('aac')
			.audioFrequency(8000)
			.audioChannels(1)
			.outputOptions(['-flush_packets 1'])

		f
			.on('end', () => {
				removeStream(newStream);
			})
			.on('error', (err) => {
				log(err.message);
				removeStream(newStream);
			})
			.pipe(res, { end: true });

		log(f._getArguments());
	});

	app.get('/video/:filename', (req, res) => {
		if (audioOnly) { res.status(404).end('Video disabled for this camera'); return; }
		const newStream = createStream(vidStreams);
		res.once('close', () => removeStream(newStream));
		newStream.stream.once('close', () => res.destroy());
		if (iFrame) {
			newStream.stream.write(iFrame);
			for (const frame of pFrame) {
				newStream.stream.write(frame);
			}
			newStream.hasIframe = true;
		}

		res.contentType('flv');
		const f = ffmpeg()
			// input
			.input(newStream.stream)
			.withInputOption(['-f h264', '-probesize 32', '-analyzeduration 100000', '-fflags +genpts', '-flags low_delay']);
		if (mediaKey) {
			f.withInputOption(['-use_wallclock_as_timestamps 1']);
			// Decode audio in this muxer instead of waiting on a second FFmpeg process.
			f.input(`${audioBaseUrl}/audio/stream.wav`)
				.withInputOption(['-f wav', '-ignore_length 1', '-max_size 256', '-probesize 32', '-analyzeduration 100000'])
				.audioCodec('aac')
				.audioBitrate('32k')
				.audioFrequency(8000)
				.audioChannels(1);
		} else {
			f.withInputFPS(fps)
				.input(`${audioBaseUrl}/audio/stream.flv`)
				.withInputOption(['-probesize 65536', '-analyzeduration 500000'])
				.audioCodec('copy');
		}
		f
			// output
			.format('flv')
			.flvmeta()
			// .size(`${width}x${height}`)
			// .videoBitrate('512k')
			// .videoCodec('libx264')
			.videoCodec('copy')
			.fps(fps)
			.outputOptions(['-flush_packets 1', '-max_interleave_delta 1000000', '-avoid_negative_ts make_zero']);

		f
			.on('end', () => {
				removeStream(newStream);
				log(`Stream ${newStream.id} stopped`);
			})
			.on('error', (err, stdout, stderr) => {
				log(err.message);
				removeStream(newStream);
				log(`Stream ${newStream.id} stopped with error`);
				if (stderr) {
					error(stderr.slice(-2000));
				}
			})
			.pipe(res, { end: true });

		log(`Stream ${newStream.id} started`);
		log(f._getArguments());
	});

	return { init, reset, handleStream, router: app, serveLive };
}

export type CameraStream = ReturnType<typeof createCameraStream>;

export function createStreamServer(listenPort: number, options: ReadonlyMap<string, { audioOnly?: boolean }>, listenHost = '127.0.0.1') {
	if (typeof listenHost !== 'string' || !isIP(listenHost)) {
		throw new Error('serverHost must be an IPv4 or IPv6 address; default is 127.0.0.1');
	}
	const localHost = listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost === '::' ? '::1' : listenHost;
	const host = isIP(localHost) === 6 ? `[${localHost}]` : localHost;
	const origin = `http://${host}:${listenPort}`;
	const app = express();
	const cameras = new Map<string, CameraStream>();
	for (const [name, camera] of options) {
		const media = createCameraStream(name, `${origin}/${name}`, camera.audioOnly);
		cameras.set(name, media);
		app.get(`/${name}.flv`, media.serveLive);
		app.use(`/${name}`, media.router);
	}
	const server = app.listen(listenPort, listenHost);
	return { server, cameras };
}
