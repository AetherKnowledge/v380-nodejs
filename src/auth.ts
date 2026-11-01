import { createCipheriv, randomBytes } from 'crypto';

export interface CameraCredentials {
	id: string;
	ip?: string;
	port?: number;
	username: string;
	password: string;
}

export function cameraId(value: string): number {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid camera device ID');
	const id = Number(value);
	if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) throw new Error('Invalid camera device ID');
	return id;
}

export function createLoginRequest(conf: CameraCredentials, modern = false): Buffer {
	const request = Buffer.alloc(modern ? 520 : 256);
	request.writeUInt32LE(1167, 0);
	request.writeUInt32LE(modern ? 120 : 1022, 4);
	request[8] = modern ? 31 : 2;
	request.writeUInt32LE(1, 9);
	request.writeUInt32LE(cameraId(conf.id), 13);
	const username = Buffer.from(conf.username);
	if (username.length > 32) throw new Error('Camera username exceeds 32 bytes');
	username.copy(request, 49);
	const password = Buffer.from(conf.password);
	if (password.length > 48) throw new Error('Camera device password exceeds 48 bytes');
	const padded = Buffer.alloc(modern ? 48 : Math.ceil((password.length + 1) / 16) * 16);
	password.copy(padded);
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%^&*()_+-=';
	const randomKey = Buffer.from(Array.from(randomBytes(16), byte => alphabet[byte % alphabet.length]).join(''));
	const inner = createCipheriv('aes-128-ecb', Buffer.from('macrovideo+*#!^@'), null).setAutoPadding(false);
	const outer = createCipheriv('aes-128-ecb', randomKey, null).setAutoPadding(false);
	const encrypted = Buffer.concat([inner.update(padded), inner.final()]);
	Buffer.concat([randomKey, outer.update(encrypted), outer.final()]).subarray(0, modern ? 64 : 32).copy(request, 81);
	return request;
}
