import { connect, Socket } from 'net';
import { createCipheriv } from 'crypto';
import { createReadStream } from 'fs';
import { access, mkdtemp, open, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Readable } from 'stream';
import { setTimeout as delay } from 'timers/promises';
import { performance } from 'perf_hooks';
import { spawn, ChildProcess } from 'child_process';
import { cameraId, CameraCredentials, createLoginRequest } from './auth';
import { readCameraBytes } from './socket';
import { ImaEncoder } from './ima';
import { alawInput } from './backchannel';

const BLOCK_MS = 505 / 8000 * 1000;

function openCamera(conf: CameraCredentials, signal: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const socket = connect({ host: conf.ip, port: conf.port || 8800 });
		const timer = setTimeout(() => failed(new Error('Camera speaker connection timed out')), 5000);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', cancelled);
			socket.removeListener('connect', connected);
			socket.removeListener('error', failed);
		};
		const failed = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
		const cancelled = () => failed(signal.reason);
		const connected = () => {
			cleanup();
			socket.setNoDelay(true);
			socket.setTimeout(5000, () => socket.destroy(new Error('Camera speaker connection timed out')));
			resolve(socket);
		};
		// Keep errors handled during the handoff to the packet reader/session.
		socket.on('error', () => {});
		socket.once('connect', connected);
		socket.once('error', failed);
		signal.addEventListener('abort', cancelled, { once: true });
	});
}

async function authenticate(conf: CameraCredentials, signal: AbortSignal) {
	for (const modern of [false, true]) {
		const socket = await openCamera(conf, signal);
		const cancel = () => socket.destroy();
		signal.addEventListener('abort', cancel, { once: true });
		try {
			signal.throwIfAborted();
			socket.write(createLoginRequest(conf, modern));
			const header = await readCameraBytes(socket, 8);
			const command = header.readInt32LE(0), result = header.readInt32LE(4);
			if (command === -100 && !modern) continue;
			if (command !== 1168 || result !== 1001) {
				throw new Error(`Camera rejected speaker login (command ${command}, result ${result}); check device credentials`);
			}
			const session = await readCameraBytes(socket, 9);
			return { version: session[4], authTicket: session.readUInt32LE(5) };
		} finally {
			signal.removeEventListener('abort', cancel);
			socket.destroy();
		}
	}
	throw new Error('Camera does not support the speaker login protocol');
}

export function speakerHandshake(id: string, ticket: number): Buffer {
	const packet = Buffer.alloc(85);
	packet.writeUInt32LE(377, 0);
	packet.writeUInt32LE(cameraId(id), 4);
	packet.writeUInt32LE(ticket, 8);
	return packet;
}

export function speakerPacket(block: Buffer, sequence: number, version: number, ticket: number): Buffer {
	if (block.length !== 256 || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid speaker audio block');
	const header = Buffer.from('b4000000010016000000000000000100', 'hex');
	header[15] = (sequence + 1) & 255;
	if (version <= 30) return Buffer.concat([header, block]);
	const key = Buffer.from('000000005c79142c46238161f00d8082', 'hex');
	key.writeUInt32LE(ticket, 0);
	const cipher = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
	return Buffer.concat([header, cipher.update(block), cipher.final()]);
}

async function* pcmBlocks(input: Readable) {
	let pending: Buffer = Buffer.alloc(0);
	for await (const chunk of input) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const data = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		let offset = 0;
		for (; offset + 1010 <= data.length; offset += 1010) yield data.subarray(offset, offset + 1010);
		pending = Buffer.from(data.subarray(offset));
	}
	if (pending.length % 2) throw new Error('Truncated 16-bit PCM sample');
	if (pending.length) yield pending;
}

// Capture starts only after login/handshake, preventing microphone backlog.
export async function sendPcm(conf: CameraCredentials, createInput: () => Readable, signal?: AbortSignal): Promise<number> {
	if (!conf.ip) throw new Error('Set the camera IP in config.json before using the speaker');
	const failure = new AbortController();
	const active = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal;
	let socket: Socket | undefined, input: Readable | undefined;
	let finished = false;
	const cancelled = () => { input?.destroy(); socket?.destroy(); };
	active.addEventListener('abort', cancelled, { once: true });
	try {
		const auth = await authenticate(conf, active);
		socket = await openCamera(conf, active);
		socket.on('error', error => failure.abort(error));
		socket.once('end', () => socket?.destroy());
		socket.once('close', () => { if (!finished) failure.abort(new Error('Camera closed the speaker connection')); });
		// The reference protocol has no documented positive handshake ACK.
		// Drain replies and catch rejection/closure before sending any samples.
		let replyPrefix: Buffer = Buffer.alloc(0);
		socket.on('data', reply => {
			if (replyPrefix.length === 4 || !Buffer.isBuffer(reply)) return;
			replyPrefix = Buffer.concat([replyPrefix, reply.subarray(0, 4 - replyPrefix.length)]);
			if (replyPrefix.length === 4 && replyPrefix.readInt32LE(0) < 0) failure.abort(new Error('Camera rejected the speaker handshake'));
		});
		socket.write(speakerHandshake(conf.id, auth.authTicket));
		await delay(500, undefined, { signal: active });
		active.throwIfAborted();
		input = createInput();
		input.on('error', error => failure.abort(error));
		const encoder = new ImaEncoder();
		let sequence = 0, next = performance.now();
		for await (const pcm of pcmBlocks(input)) {
			active.throwIfAborted();
			if (performance.now() - next > BLOCK_MS * 4) next = performance.now();
			await delay(Math.max(0, next - performance.now()), undefined, { signal: active });
			const packet = speakerPacket(encoder.encode(pcm), sequence, auth.version, auth.authTicket);
			await new Promise<void>((resolve, reject) => socket!.write(packet, error => error ? reject(error) : resolve()));
			sequence++;
			next += BLOCK_MS;
		}
		active.throwIfAborted();
		if (!sequence) throw new Error('No audio samples received');
		await delay(Math.max(0, next - performance.now()), undefined, { signal: active });
		finished = true;
		return sequence;
	} catch (error) {
		throw active.aborted ? active.reason : error;
	} finally {
		finished = true;
		active.removeEventListener('abort', cancelled);
		input?.destroy();
		socket?.destroy();
	}
}

export async function waveInput(filename: string): Promise<() => Readable> {
	const file = await open(filename, 'r');
	let dataStart = 0, dataSize = 0, format = false;
	try {
		const size = (await file.stat()).size;
		const header = Buffer.alloc(12);
		if ((await file.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
			throw new Error('Expected a PCM WAV file');
		}
		const end = header.readUInt32LE(4) + 8;
		if (end > size) throw new Error('Truncated WAV file');
		for (let offset = 12; offset + 8 <= end;) {
			const chunk = Buffer.alloc(8);
			await file.read(chunk, 0, 8, offset);
			const length = chunk.readUInt32LE(4), start = offset + 8;
			if (start + length > end) throw new Error('Truncated WAV chunk');
			if (chunk.toString('ascii', 0, 4) === 'fmt ') {
				if (length < 16) throw new Error('Invalid WAV format chunk');
				const fmt = Buffer.alloc(16);
				await file.read(fmt, 0, 16, start);
				if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 8000 ||
					fmt.readUInt32LE(8) !== 16000 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) {
					throw new Error('WAV must be PCM signed 16-bit, 8000 Hz, mono');
				}
				format = true;
			} else if (chunk.toString('ascii', 0, 4) === 'data' && !dataStart) {
				dataStart = start; dataSize = length;
			}
			offset = start + length + (length & 1);
		}
		if (!format || !dataStart || !dataSize || dataSize % 2) throw new Error('WAV has no complete PCM samples');
	} finally { await file.close(); }
	return () => createReadStream(filename, { start: dataStart, end: dataStart + dataSize - 1 });
}

export async function runSpeak(conf: CameraCredentials, args: string[]) {
	const control = new AbortController();
	const stop = () => control.abort(new Error('Speaker playback stopped'));
	let capture: ChildProcess | undefined;
	let backchannel: Readable | undefined;
	let testDirectory: string | undefined;
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	try {
		let createInput: () => Readable;
		if (args[0] === '--test' && args.length <= 2) {
			const source = resolve(args[1] || 'test.mp3');
			await access(source);
			testDirectory = await mkdtemp(join(tmpdir(), 'v380-speaker-'));
			const wave = join(testDirectory, 'test.wav');
			console.error(`Converting ${source} for speaker playback`);
			await new Promise<void>((done, reject) => {
				capture = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source, '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', wave], {
					windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: control.signal,
				});
				let errorText = '';
				let conversionError: Error | undefined;
				capture.stderr!.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(-1500); });
				capture.once('error', error => { conversionError = new Error(`Audio conversion failed: ${error.message}; install FFmpeg and add it to PATH`); });
				capture.once('close', code => {
					if (conversionError) reject(conversionError);
					else if (code === 0) done();
					else reject(new Error(`Audio conversion failed: ${errorText.trim() || code}`));
				});
			});
			createInput = await waveInput(wave);
		} else if (args[0] === '--mic' && args.length <= 2) {
			const device = args[1];
			if (process.platform === 'win32' && !device) throw new Error('Specify the Windows microphone name: speak --mic "Microphone (...)"');
			if (!['win32', 'linux'].includes(process.platform)) throw new Error('Microphone capture supports Windows and Linux; use --pcm-stdin on other systems');
			createInput = () => {
				const input = process.platform === 'win32' ? ['-f', 'dshow', '-i', `audio=${device}`] : ['-f', 'alsa', '-i', device || 'default'];
				capture = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
				let errorText = '';
				capture.stderr!.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(-1500); });
				capture.once('error', error => control.abort(new Error(`Microphone capture failed: ${error.message}; install FFmpeg and add it to PATH`)));
				capture.once('exit', code => { if (code && !control.signal.aborted) control.abort(new Error(`Microphone capture failed: ${errorText.trim() || code}`)); });
				return capture.stdout!;
			};
		} else if (args[0] === '--pcm-stdin' && args.length === 1) {
			createInput = () => process.stdin;
		} else if (args[0] === '--alaw-stdin' && args.length === 1) {
			backchannel = await alawInput(process.stdin, control.signal);
			if (!backchannel) return;
			createInput = () => backchannel!;
		} else if (args.length === 1 && !args[0].startsWith('-')) {
			createInput = await waveInput(args[0]);
		} else {
			throw new Error('Usage: speak <audio.wav> | speak --test [audio-file] | speak --mic [device] | speak --pcm-stdin | speak --alaw-stdin');
		}
		console.error('Connecting to camera speaker; Ctrl+C stops playback');
		const blocks = await sendPcm(conf, createInput, control.signal);
		console.error(`Sent ${(blocks * BLOCK_MS / 1000).toFixed(2)} seconds of audio`);
	} catch (error) {
		if (!control.signal.aborted) throw error;
		if (control.signal.reason?.message !== 'Speaker playback stopped') throw control.signal.reason;
	} finally {
		process.removeListener('SIGINT', stop);
		process.removeListener('SIGTERM', stop);
		backchannel?.destroy();
		if (capture && capture.exitCode === null) capture.kill();
		if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
	}
}
