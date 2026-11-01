// import beamcoder = require('beamcoder');
import ffmpeg = require('fluent-ffmpeg');
import express = require('express');
import { Socket } from 'net';
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

let curId = 0;
let width = 0;
let height = 0;
let fps = 0;
let serverPort = 0;
let mediaKey: Buffer | undefined;
let listening = false;
const app = express();
const live = new LiveFlv();

// Cache a complete, bounded chain from a keyframe through the latest P-frame.
const MAX_CACHED_PFRAMES = 200;
const MAX_VIDEO_BUFFER_BYTES = 8 * 1024 * 1024;
let pFrame: Buffer[] = [];
let iFrame: Buffer | undefined;
let videoCacheBytes = 0;

export function init(listenPort: number, packet: any, auth?: { version: number; authTicket: number }) {
	reset();
	width = packet.width;
	height = packet.height;
	fps = packet.maybeFps;
	serverPort = listenPort;
	mediaKey = undefined;
	if (auth && auth.version > 30) {
		if (packet.maybeFps !== 20) {
			throw new Error(`Unsupported encrypted-media communication version ${packet.maybeFps}`);
		}
		mediaKey = Buffer.from('000000005c79142c46238161f00d8082', 'hex');
		mediaKey.writeUInt32LE(auth.authTicket, 0);
	}
	console.log(mediaKey ? `${width}x${height} (camera timestamps)` : `${width}x${height} @ ${fps} fps`);

	if (!listening) {
		app.listen(listenPort);
		listening = true;
		console.log(`Server started at port ${serverPort}`);
	}
}

export function reset() {
	videoPacketQueue = [];
	audioPacketQueue = [];
	iFrame = undefined;
	pFrame = [];
	videoCacheBytes = 0;
	live.reset();
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
export async function handleStream(packet: Buffer, sock: Socket) {
	const streamPacket = streamStruct.unpack(new t.Pointer(packet, 1));

	if (!streamPacket.len || streamPacket.len > 500 || !streamPacket.totalFrame || streamPacket.curFrame >= streamPacket.totalFrame) {
		throw new Error('Invalid camera frame fragment header');
	}
	const streamData = await readCameraBytes(sock, streamPacket.len);

	switch (streamPacket.type) {
		case 0x00: // Probably I-frame
			videoPacketQueue.push(streamData);
			if (streamPacket.curFrame === streamPacket.totalFrame - 1) {
				// console.log('i frame');
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
				// console.log('p frame');
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
				if (mediaKey) live.audio(concatBuff, frameTimestamp(frame));
				for (const s of audStreams) {
					s.stream.write(concatBuff);
				}
				audioPacketQueue = [];
			}
			break;

		default:
			console.log('unknown type', streamPacket.type);
	}
}

app.get('/live.flv', (req, res) => {
	if (!mediaKey) {
		res.redirect('/video/stream.flv');
		return;
	}
	res.contentType('flv');
	res.setHeader('Cache-Control', 'no-store');
	res.socket?.setNoDelay(true);
	live.attach(res);
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
			console.log(err.message);
			removeStream(newStream);
		})
		.pipe(res, { end: true });

	console.log(f._getArguments());
});

app.get('/video/:filename', (req, res) => {
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
		f.input(`http://127.0.0.1:${serverPort}/audio/stream.wav`)
			.withInputOption(['-f wav', '-ignore_length 1', '-max_size 256', '-probesize 32', '-analyzeduration 100000'])
			.audioCodec('aac')
			.audioBitrate('32k')
			.audioFrequency(8000)
			.audioChannels(1);
	} else {
		f.withInputFPS(fps)
			.input(`http://127.0.0.1:${serverPort}/audio/stream.flv`)
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
			console.log(`Stream ${newStream.id} stopped`);
		})
		.on('error', (err, stdout, stderr) => {
			console.log(err.message);
			removeStream(newStream);
			console.log(`Stream ${newStream.id} stopped with error`);
			if (stderr) {
				console.error(stderr.slice(-2000));
			}
		})
		.pipe(res, { end: true });

	console.log(`Stream ${newStream.id} started`);
	console.log(f._getArguments());
});
