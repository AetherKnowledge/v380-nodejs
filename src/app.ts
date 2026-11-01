import { argv } from 'process';
import { readFile } from 'fs/promises';
import { parseConfig, parseOptions, selectCamera } from './config';
import { createCameraSession } from './camera';
import { createStreamServer } from './stream';
import { runSpeak } from './speak';
import * as discovery from './discovery';

async function entry() {
	const options = parseOptions(argv.slice(2));
	if (options.args[0] === 'discover' && options.args.length === 1) {
		console.log(await discovery.discover());
		return;
	}
	const command = options.args[0];
	if (command !== undefined && command !== 'speak') {
		throw new Error('Usage: [--config /path/config.json] [--camera name] [speak ... | discover]');
	}
	let text: string;
	try { text = await readFile(options.configPath, 'utf8'); }
	catch { throw new Error(`Please create ${options.configPath} file, see config.example.json`); }
	const config = parseConfig(JSON.parse(text));
	if (command === 'speak') {
		const [, camera] = selectCamera(config, options.camera);
		await runSpeak(camera, options.args.slice(1));
		return;
	}
	const cameras = options.camera ? new Map([selectCamera(config, options.camera)]) : config.cameras;
	const http = createStreamServer(config.serverPort, cameras, config.serverHost);
	const sessions = new Map<string, ReturnType<typeof createCameraSession>>();
	const failed = new Set<string>();
	const stop = () => {
		for (const session of sessions.values()) session.stop();
		http.server.close();
		http.server.closeAllConnections();
	};
	http.server.once('error', error => {
		console.error(`HTTP server failed: ${error.message}`);
		process.exitCode = 1;
		stop();
	});
	http.server.once('listening', () => console.log(`Server listening on ${config.serverHost}:${config.serverPort}`));
	for (const [name, camera] of cameras) {
		const session = createCameraSession(name, camera, http.cameras.get(name)!, () => {
			failed.add(name);
			if (failed.size === cameras.size) {
				process.exitCode = 1;
				stop();
			}
		});
		sessions.set(name, session);
		session.start();
	}
}

entry().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
