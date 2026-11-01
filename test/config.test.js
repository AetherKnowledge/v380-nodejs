require('ts-node/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseConfig, parseOptions, selectCamera } = require('../src/config');

const camera = {id: '123456789', ip: '127.0.0.1', username: 'admin', password: ''};

test('named camera config keeps HTTP settings global and credentials separate', () => {
  const conf = parseConfig({serverPort: 8800, garage: camera, front_door: {...camera, id: '42', port: 8801, audioOnly: true}});
  assert.equal(conf.serverHost, '127.0.0.1');
  assert.equal(conf.serverPort, 8800);
  assert.deepEqual([...conf.cameras.keys()], ['garage', 'front_door']);
  assert.equal(conf.cameras.get('front_door').port, 8801);
  assert.equal(conf.cameras.get('front_door').audioOnly, true);
  assert.equal(conf.cameras.get('garage').audioOnly, undefined);
  assert.equal(conf.cameras.get('garage').id, camera.id);
  assert.notStrictEqual(conf.cameras.get('garage'), camera);
  assert.throws(() => selectCamera(conf), /--camera/);
  assert.equal(selectCamera(conf, 'front_door')[1].id, '42');
  assert.throws(() => selectCamera(conf, 'missing'), /Unknown camera/);
  assert.equal(selectCamera(parseConfig({serverPort: 8800, garage: camera}))[0], 'garage');
});

test('flat configs and unsafe, empty, or malformed named camera configs are rejected', () => {
  assert.throws(() => parseConfig({serverPort: 8800, ...camera}), /flat configs are not supported/);
  for (const name of ['../garage', 'garage.flv', 'Garage', 'garage room', '', 'a'.repeat(65)]) {
    assert.throws(() => parseConfig({serverPort: 8800, [name]: camera}), /Invalid camera name/);
  }
  for (const input of [null, [], {}, {serverPort: 8800}, {serverPort: 0, garage: camera}, {serverPort: 8800, serverHost: '', garage: camera}]) {
    assert.throws(() => parseConfig(input));
  }
  for (const changes of [{id: '0'}, {ip: ''}, {password: null}, {username: 5}, {port: -1}, {serverPort: 4000}, {audioOnly: 'true'}, {audioOnly: null}]) {
    assert.throws(() => parseConfig({serverPort: 8800, garage: {...camera, ...changes}}));
  }
  const names = parseConfig({serverPort: 8800, constructor: camera});
  assert.equal(selectCamera(names, 'constructor')[0], 'constructor');
});

test('speaker and VLC CLI options select cameras before or after the command', () => {
  for (const args of [
    ['--config', '/opt/v380/config.json', '--camera', 'garage', 'speak', '--alaw-stdin'],
    ['speak', '--alaw-stdin', '--camera', 'garage', '--config', '/opt/v380/config.json'],
  ]) {
    assert.deepEqual(parseOptions(args), {configPath: '/opt/v380/config.json', camera: 'garage', args: ['speak', '--alaw-stdin']});
  }
  assert.deepEqual(parseOptions(['--camera', 'garage']), {configPath: './config.json', camera: 'garage', args: []});
  assert.throws(() => parseOptions(['--camera']), /needs a value/);
  assert.throws(() => parseOptions(['--config', '--test']), /needs a value/);
  assert.throws(() => parseOptions(['--camera', 'garage', '--camera', 'other']), /only once/);
});
