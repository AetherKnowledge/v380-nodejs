const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { serverPort } = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
  throw new Error('Set a valid serverPort in config.json');
}
const installed = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
  .filter(Boolean).map(root => path.join(root, 'VideoLAN', 'VLC', 'vlc.exe'));
const executable = installed.find(file => fs.existsSync(file)) || 'vlc';
const url = `http://127.0.0.1:${serverPort}/live.flv`;
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
