import { argv } from 'process';
import * as crypto from 'crypto';
import * as discovery from './discovery';
import * as t from 'typebase';
import * as net from 'net';
import * as fs from 'fs';
import { promisify } from 'util';
import { handleStream, init, reset } from './stream';
import { readCameraBytes } from './socket';

const readFileAsync = promisify(fs.readFile);
const statAsync = promisify(fs.stat);

const loginStruct = t.Struct.define([
	['command', t.i32],
	['unknown1', t.ui32], // 120 = LoginFromServerEX, 1002 = LoginFromMRServerEX, 1022 = our
	['unknown2', t.ui8], // 1, 2=our
	['unknown3', t.ui32],
	['deviceId', t.ui32], // 10 = LoginFromServerEX, 11 = LoginFromMRServerEX, 1=our
	['hostDateTime', t.List.define(t.ui8, 32)], // optional - maybe related to unk1/2, on v380 pc this is a domain name
	['username', t.List.define(t.ui8, 32)],
	['password', t.List.define(t.ui8, 64)], // legacy sends 32 bytes; newer firmware sends 64
]);

const streamLoginLanStruct = t.Struct.define([
	['command', t.i32],
	['deviceId', t.ui32],   // 4:  +292
	['unknown1', t.ui32],   // 8:  +284    = HSPI_V_StartPreview a4
	['maybeFps', t.ui16],   // 12: hardcoded to 20
	['authTicket', t.ui32], // 14: +304
	['unknown3', t.ui32],   // 18: unused
	['unknown4', t.ui32],   // 22: *(+344) == !0 + 4096 (v14 + 4096) "0x1001" audio related?
	['resolution', t.ui32], // 26: +288    = 0 = LowRes, 1 = HiRes
	['unknown6', t.ui32],   // 30: unused
]);

const streamStartStruct = t.Struct.define([
	['command', t.i32],
	['unknown1', t.ui32],
]);

const loginRespStruct = t.Struct.define([
	['command', t.i32],
	['loginResult', t.i32],
	['resultValue', t.i32],
	['version', t.ui8],
	['authTicket', t.ui32],
	['session', t.ui32],
	['deviceType', t.ui8],
	['camType', t.ui8],
	['vendorId', t.ui16],
	['isDomainExists', t.ui16],
	['domain', t.List.define(t.ui8, 32)],
	['recDevId', t.i32],
	['nChannels', t.ui8],
	['nAudioPri', t.ui8],
	['nVideoPri', t.ui8],
	['nSpeaker', t.ui8],
	['nPtzPri', t.ui8],
	['nReversePri', t.ui8],
	['nPtzXPri', t.ui8],
	['nPtzXCount', t.ui8],
	['settings', t.List.define(t.ui8, 32)],
	['panoX', t.ui16],
	['panoY', t.ui16],
	['panoRad', t.ui16], // 107
	['unknown1', t.ui32],
	['canUpdateDevice', t.ui32], // 112 (canUpdateDevice = [112] == 2)
]);

const streamLogin301RespStruct = t.Struct.define([
	['command', t.i32],
	['v21', t.i32],
	['maybeFps', t.ui16],
	['width', t.ui32],
	['height', t.ui32],
]);

interface IConfigFile {
	id: string;
	ip?: string;
	port?: number;
	username: string;
	password: string;
	serverPort: number;
}

function generatePassword(password: string, modern = false) {
	const generateRandomPrintable = (length: number) => {
		const set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%^&*()_+-=';
		let s = '';

		for (let i = 0; i < length; i++) {
			s += set[Math.floor(Math.random() * set.length)];
		}

		return s;
	}

	const nBlockLen = 16;
	const randomKey = generateRandomPrintable(nBlockLen);
	const staticKey = 'macrovideo+*#!^@';
	const passwordBytes = Buffer.from(password);
	const paddedLength = modern ? 48 : Math.ceil((passwordBytes.length + 1) / nBlockLen) * nBlockLen;
	if (passwordBytes.length > paddedLength) {
		throw new Error('Camera device password exceeds 48 bytes');
	}
	const paddedPassword = Buffer.alloc(paddedLength);
	passwordBytes.copy(paddedPassword);

	const cipher1 = crypto.createCipheriv('aes-128-ecb', staticKey, null);
	const cipher2 = crypto.createCipheriv('aes-128-ecb', randomKey, null);

	cipher1.setAutoPadding(false);
	cipher2.setAutoPadding(false);
	const res1 = Buffer.concat([cipher1.update(paddedPassword), cipher1.final()]);
	const res2 = Buffer.concat([cipher2.update(res1), cipher2.final()]);

	return Buffer.concat([Buffer.from(randomKey), res2]);
}

let preferredModern = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;

function reconnect() {
	if (reconnectTimer !== undefined) return;
	reset();
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, 30000);
	console.log(`Camera disconnected; reconnecting in ${delay / 1000}s`);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		entry(preferredModern).catch(err => {
			console.error(err);
			process.exitCode = 1;
		});
	}, delay);
}

async function entry(modern = preferredModern) {
	if (argv.indexOf('discover') >= 0) {
		console.log('Discovering...');
		const res = discovery.discover();
		console.log(res);
		return;
	}

	try {
		await statAsync('./config.json');
	} catch (err) {
		console.error('Please create config.json file, see config.example.json');
		process.exitCode = 1;
		return;
	}

	try {
		const confRaw = await readFileAsync('./config.json');
		const conf: IConfigFile = JSON.parse(confRaw.toString());

		if (!conf.ip) {
			const discRes = await discovery.discover();
			console.log(discRes);
			// TODO: assign IP address after discovery
		}

		const host = conf.ip;
		const port = conf.port || 8800;
		const socketAuth = net.connect({
			host,
			port,
		});
		let authFinished = false;

		socketAuth.on('connect', () => {
			try {
				const buff = Buffer.alloc(modern ? 520 : 256);
				const loginReq = new t.Pointer(buff, 0);

				const loginReqData = {
					command: 1167,
					deviceId: Buffer.from(conf.id),
					unknown1: modern ? 120 : 1022,
					unknown2: modern ? 31 : 2,
					unknown3: 1,
					hostDateTime: [],
					username: Buffer.from(conf.username),
					password: generatePassword(conf.password, modern).subarray(0, modern ? 64 : 32),
				}

				loginStruct.pack(loginReq, loginReqData);
				socketAuth.write(buff);
			} catch (err) {
				failAuth(err instanceof Error ? err.message : String(err));
			}
		});

		const failAuth = (message: string, retry = false) => {
			if (authFinished) return;
			authFinished = true;
			console.error(message);
			socketAuth.destroy();
			if (retry) reconnect();
			else process.exitCode = 1;
		};
		let authData = Buffer.alloc(0);
		socketAuth.setTimeout(5000);
		socketAuth.on('timeout', () => failAuth('Camera authentication timed out', true));
		socketAuth.on('error', (err) => failAuth(`Camera authentication failed: ${err.message}`, true));
		socketAuth.on('end', () => failAuth('Camera closed connection before completing authentication', true));
		socketAuth.on('close', () => failAuth('Camera authentication connection closed', true));
		socketAuth.on('data', (data: Buffer) => {
			if (authFinished || socketAuth.destroyed) {
				return;
			}
			// TCP may split a login reply across several data events.
			authData = Buffer.concat([authData, data.subarray(0, loginRespStruct.size - authData.length)]);
			if (authData.length < 8) {
				return;
			}
			const command = authData.readInt32LE(0);
			const result = authData.readInt32LE(4);
			if (command === -100 && !modern) {
				authFinished = true;
				preferredModern = true;
				socketAuth.destroy();
				console.log('Retrying camera login using newer firmware protocol');
				entry(true).catch((err) => {
					console.error(err);
					process.exitCode = 1;
				});
				return;
			}
			if (command !== 1168) {
				failAuth(`Camera rejected authentication protocol (response command ${command}; expected 1168). This firmware may require a newer V380 login protocol.`);
				return;
			}
			if (result !== 1001) {
				const errors: { [code: number]: string } = {
					1011: 'Invalid camera username',
					1012: 'Invalid camera device password (use the device password, separate from the V380 app account password)',
					1018: 'Invalid camera device ID',
				};
				failAuth(errors[result] || `Camera authentication rejected (code ${result})`);
				return;
			}
			if (authData.length < loginRespStruct.size) {
				return;
			}
			const loginResp = loginRespStruct.unpack(new t.Pointer(authData));
			console.log('Camera logged in');
			authFinished = true;
			preferredModern = modern;
			socketAuth.destroy();
			startStreaming(conf, loginResp);
		});
	} catch (err) {
		console.error(err);
		process.exitCode = 1;
	}
}

entry().catch((err) => {
	console.error(err);
	process.exitCode = 1;
})

function startStreaming(conf: IConfigFile, resp: any) {
	let stage = 0;
	let startedAt = 0;
	let reading = Promise.resolve();
	const buff = Buffer.alloc(256);
	const socketStream = net.connect({
		host: conf.ip,
		port: conf.port || 8800,
	});

	socketStream.setTimeout(5000);
	socketStream.on('timeout', () => socketStream.destroy(new Error('Camera stream timed out')));
	socketStream.setNoDelay(true); // Disable nagle algorithm

	socketStream.on('connect', () => {
		try {
			const streamLoginLanReq = new t.Pointer(buff, 0);
			const streamLoginLanData = {
				command: 301,
				deviceId: Buffer.from(conf.id),
				unknown1: 0,
				maybeFps: 20, // Communication version, hardcoded in HSPC_PreviewDLL.dll.
				authTicket: resp.authTicket,
				unknown4: 4096 + 1,
				resolution: 1,
			};
			streamLoginLanStruct.pack(streamLoginLanReq, streamLoginLanData);
			socketStream.write(buff);
		} catch (err) {
			socketStream.destroy(err instanceof Error ? err : new Error(String(err)));
		}
	});

	socketStream.on('readable', () => {
		if (socketStream.destroyed || stage !== 0) return;
		try {
			// Newer firmware sends a 32-byte reply; wait for it across TCP chunks.
			const replySize = resp.version > 30 ? 32 : socketStream.readableLength;
			if (replySize < streamLogin301RespStruct.size) {
				return;
			}
			const data = socketStream.read(replySize);
			if (data === null) {
				return;
			}

			const streamLoginResp = streamLogin301RespStruct.unpack(new t.Pointer(data));
			if (streamLoginResp.command !== 401) {
				throw new Error(`Login response: expected 401, got ${streamLoginResp.command}`);
			}

			if (streamLoginResp.v21 === -11 || streamLoginResp.v21 === -12) {
				console.error(`Login response: unsupported ${streamLoginResp.v21}, continuing`);
			} else if (streamLoginResp.v21 !== 402 && streamLoginResp.v21 !== 1001) {
				throw new Error(`Login response: unsupported ${streamLoginResp.v21}`);
			}
			if (!streamLoginResp.width || !streamLoginResp.height || !streamLoginResp.maybeFps) {
				socketStream.destroy(new Error(`Camera supplied no video metadata (stream login code ${streamLoginResp.v21}); stream not started`));
				return;
			}

			if (resp.version > 30) {
				buff.fill(0);
			}
			const streamStartReq = new t.Pointer(buff, 0);
			const streamStartData = {
				command: 303,
				// Newer firmware uses a fixed stream-start flag; preserve legacy encoding.
				unknown1: resp.version > 30 ? 0x3001 : streamLoginResp.v21 >>> 0,
			}

			streamStartStruct.pack(streamStartReq, streamStartData);
			socketStream.write(buff);

			stage++;
			init(conf.serverPort, streamLoginResp, resp);
			startedAt = Date.now();
			reading = readStreamPacket(socketStream).catch((err) => { socketStream.destroy(err); });
		} catch (err) {
			socketStream.destroy(err instanceof Error ? err : new Error(String(err)));
		}
	});

	socketStream.on('end', () => {
		socketStream.destroy();
	})

	socketStream.on('error', (err) => {
		console.error(err.message);
	});
	socketStream.once('close', () => {
		if (startedAt && Date.now() - startedAt >= 30000) reconnectDelay = 1000;
		// Drain the old packet reader before clearing shared frame/decryption state.
		reading.then(reconnect);
	});
}

async function readStreamPacket(socketStream: net.Socket) {
	while (!socketStream.destroyed && !socketStream.readableEnded) {
		const data = await readCameraBytes(socketStream, 12);
		if (data[0] === 0x7f) {
			await handleStream(data, socketStream);
		} else if (data[0] === 0x1f) {
			console.error('Unparsed 0x1f data');
		} else if (data[0] === 0x6f) {
			// Should sleep(20 ms)
		} else {
			console.error('Unknown data: ' + data[0]);
		}
	}

}
