const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const result = spawnSync(process.execPath, [
  '--require', require.resolve('ts-node/register'),
  path.join(root, 'src/app.ts'), 'speak', '--test', ...process.argv.slice(2),
], { cwd: root, stdio: 'inherit', windowsHide: true });

if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
