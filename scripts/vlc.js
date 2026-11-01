require('ts-node/register');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isIP } = require('net');
const { parseConfig, parseOptions, selectCamera } = require('../src/config');

const options = parseOptions(process.argv.slice(2));
if (options.args.length) throw new Error('Usage: npm run vlc -- --camera <name> [--config /path/config.json]');
const config = parseConfig(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', options.configPath), 'utf8')));
const { serverPort, serverHost } = config;
const [name] = selectCamera(config, options.camera);
const installed = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
  .filter(Boolean).map(root => path.join(root, 'VideoLAN', 'VLC', 'vlc.exe'));
const executable = installed.find(file => fs.existsSync(file)) || 'vlc';
const host = serverHost === '0.0.0.0' ? '127.0.0.1' : serverHost === '::' ? '::1' : serverHost;
const url = `http://${isIP(host) === 6 ? `[${host}]` : host}:${serverPort}/${name}.flv`;
console.log(`Opening ${url} with 200 ms network caching. Keep npm start running.`);
const player = spawn(executable, [
  '--no-one-instance', '--network-caching=200', '--clock-jitter=100',
  '--no-video-title-show', url,
], { stdio: 'ignore', windowsHide: false });
player.on('error', error => {
  console.error(error.code === 'ENOENT' ? 'VLC not found. Install VLC or add it to PATH.' : error.message);
  process.exitCode = 1;
});
player.on('exit', code => { process.exitCode = code || 0; });
