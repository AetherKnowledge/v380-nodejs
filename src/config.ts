import { isIP } from 'net';
import { cameraId, CameraCredentials } from './auth';

export interface CameraConfig extends CameraCredentials {
	audioOnly?: boolean;
}

export interface BridgeConfig {
	serverPort: number;
	serverHost: string;
	cameras: Map<string, CameraConfig>;
}

const cameraFields = new Set(['id', 'ip', 'port', 'username', 'password', 'audioOnly']);

export function parseConfig(value: unknown): BridgeConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must be a JSON object');
	const raw = value as Record<string, unknown>;
	const serverPort = raw.serverPort;
	const serverHost = raw.serverHost === undefined ? '127.0.0.1' : raw.serverHost;
	if (!Number.isInteger(serverPort) || (serverPort as number) < 1 || (serverPort as number) > 65535) {
		throw new Error('serverPort must be an integer from 1 to 65535');
	}
	if (typeof serverHost !== 'string' || !isIP(serverHost)) throw new Error('serverHost must be an IPv4 or IPv6 address');
	const cameras = new Map<string, CameraConfig>();
	for (const [name, settings] of Object.entries(raw)) {
		if (name === 'serverHost' || name === 'serverPort') continue;
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid camera name '${name}'; use lowercase letters, digits, hyphens, or underscores`);
		if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
			throw new Error(`Camera '${name}' must be an object. Put camera settings under a name such as garage; flat configs are not supported`);
		}
		const camera = settings as Record<string, unknown>;
		for (const field of Object.keys(camera)) {
			if (!cameraFields.has(field)) throw new Error(`Unknown setting '${name}.${field}'; serverHost and serverPort belong outside camera objects`);
		}
		try { cameraId(camera.id as string); } catch { throw new Error(`Camera '${name}' needs a valid numeric device ID string`); }
		if (typeof camera.ip !== 'string' || !camera.ip.trim()) throw new Error(`Camera '${name}' needs an IP address or hostname`);
		if (typeof camera.username !== 'string' || typeof camera.password !== 'string') throw new Error(`Camera '${name}' needs string username and password fields`);
		if (camera.audioOnly !== undefined && typeof camera.audioOnly !== 'boolean') throw new Error(`Camera '${name}' audioOnly must be true or false`);
		if (camera.port !== undefined && (!Number.isInteger(camera.port) || (camera.port as number) < 1 || (camera.port as number) > 65535)) {
			throw new Error(`Camera '${name}' port must be an integer from 1 to 65535`);
		}
		cameras.set(name, {
			id: camera.id as string, ip: camera.ip, username: camera.username, password: camera.password,
			...(camera.port === undefined ? {} : { port: camera.port as number }),
			...(camera.audioOnly === undefined ? {} : { audioOnly: camera.audioOnly as boolean }),
		});
	}
	if (!cameras.size) throw new Error('Configure at least one named camera, such as garage: { id, ip, username, password }');
	return { serverPort: serverPort as number, serverHost, cameras };
}

export function selectCamera(config: BridgeConfig, name?: string): [string, CameraConfig] {
	if (name !== undefined) {
		const camera = config.cameras.get(name);
		if (!camera) throw new Error(`Unknown camera '${name}'; configured cameras: ${[...config.cameras.keys()].join(', ')}`);
		return [name, camera];
	}
	if (config.cameras.size !== 1) throw new Error(`Select a camera with --camera <name>; configured cameras: ${[...config.cameras.keys()].join(', ')}`);
	return config.cameras.entries().next().value!;
}

export function parseOptions(input: string[]) {
	const args = [...input];
	let configPath: string | undefined, camera: string | undefined;
	for (let index = 0; index < args.length;) {
		const flag = args[index];
		if (flag !== '--config' && flag !== '--camera') { index++; continue; }
		const value = args[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
		if (flag === '--config') {
			if (configPath !== undefined) throw new Error('Specify --config only once');
			configPath = value;
		} else {
			if (camera !== undefined) throw new Error('Specify --camera only once');
			camera = value;
		}
		args.splice(index, 2);
	}
	return { configPath: configPath ?? './config.json', camera, args };
}
