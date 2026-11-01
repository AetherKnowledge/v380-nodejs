const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

const config = {
  id: '123456789', ip: '127.0.0.1', username: 'camera-user',
  password: 'camera-password', serverPort: 4000,
};

function source(name) {
  return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
}
const appSource = source('app.ts');
const cameraSource = source('camera.ts');
const configContext = { exports: {}, Buffer, require: name => name === './auth' ? authContext.exports : require(name) };
const streamSource = source('stream.ts');
const socketContext = { exports: {} };
vm.runInNewContext(source('socket.ts'), socketContext);
const imaContext = { exports: {}, Buffer };
vm.runInNewContext(source('ima.ts'), imaContext);
const authContext = { exports: {}, Buffer, require };
vm.runInNewContext(source('auth.ts'), authContext);
vm.runInNewContext(source('config.ts'), configContext);
const liveContext = { exports: {}, Buffer, require: name => name === './ima' ? imaContext.exports : require(name) };
vm.runInNewContext(source('live.ts'), liveContext);
const { readCameraBytes } = socketContext.exports;

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.readableEnded = false;
    this.buffer = Buffer.alloc(0);
    this.writes = [];
  }
  get readableLength() { return this.buffer.length; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  write(data) { this.writes.push(Buffer.from(data)); return true; }
  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
  read(size) {
    if (this.buffer.length < size) return null;
    const data = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return data;
  }
  receive(data, event = 'data') {
    if (event === 'data') this.emit(event, data);
    else {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.emit(event);
    }
  }
}

async function loadApp(clock = Date, argv = [], overrides = {}) {
  const sockets = [], errors = [], initialized = [], timers = [], resets = [], logs = [], configPaths = [], bindings = [];
  const spoken = [];
  const fakeProcess = { argv, exitCode: 0 };
  const credentials = { id: config.id, ip: config.ip, username: config.username, password: config.password };
  const shared = {
    Buffer, Date: clock,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    console: { log: message => logs.push(message), error: error => errors.push(String(error)) },
  };
  const cameraContext = { ...shared, exports: {}, require(name) {
    if (name === './auth') return authContext.exports;
    if (name === './socket') return socketContext.exports;
    if (name === 'net') return { connect() { const socket = new FakeSocket(); sockets.push(socket); return socket; } };
    return require(name);
  } };
  vm.runInNewContext(cameraSource, cameraContext);
  vm.runInNewContext(appSource, {
    ...shared, exports: {}, process: fakeProcess,
    require(name) {
      if (name === 'process') return fakeProcess;
      if (name === './discovery') return {};
      if (name === './config') return configContext.exports;
      if (name === './camera') return cameraContext.exports;
      if (name === './speak') return { runSpeak: (...args) => spoken.push(args) };
      if (name === './stream') return { createStreamServer(port, options, host) {
        bindings.push({port, host});
        const server = new EventEmitter(); server.close = () => {}; server.closeAllConnections = () => {};
        return { server, cameras: new Map([...options.keys()].map(name => [name, {
          init: (...args) => initialized.push([port, ...args]), reset: () => resets.push(name), handleStream() {},
        }])) };
      } };
      if (name === 'fs/promises') return { readFile: async file => {
        configPaths.push(file); return JSON.stringify({serverPort: config.serverPort, garage: credentials, ...overrides});
      } };
      return require(name);
    },
  });
  await new Promise(setImmediate);
  return { sockets, errors, initialized, fakeProcess, timers, resets, logs, spoken, configPaths, bindings,
    async retry() {
      assert.ok(timers.length, 'Expected a scheduled reconnect');
      const timer = timers.shift(); timer.callback();
      await new Promise(setImmediate);
      return timer.delay;
    },
  };
}

function authReply(command = 1168, result = 1001, version = 2) {
  const data = Buffer.alloc(256);
  data.writeInt32LE(command, 0);
  data.writeInt32LE(result, 4);
  data[12] = version;
  data.writeUInt32LE(42, 13);
  return data;
}

test('speak CLI dispatch uses existing config without opening the video connection', async () => {
  const app = await loadApp(Date, ['node', 'app.ts', 'speak', '--mic', 'test device']);
  assert.equal(app.sockets.length, 0);
  assert.equal(app.initialized.length, 0);
  assert.equal(app.spoken.length, 1);
  assert.equal(app.spoken[0][0].id, config.id);
  assert.deepEqual(Array.from(app.spoken[0][1]), ['--mic', 'test device']);
});

test('go2rtc CLI uses explicit config path without starting the video server', async () => {
  const app = await loadApp(Date, ['node', 'app.ts', '--config', '/opt/v380/config.json', 'speak', '--alaw-stdin']);
  assert.deepEqual(app.configPaths, ['/opt/v380/config.json']);
  assert.equal(app.sockets.length, 0);
  assert.equal(app.initialized.length, 0);
  assert.equal(app.spoken.length, 1);
  assert.deepEqual(Array.from(app.spoken[0][1]), ['--alaw-stdin']);
});

async function modernAttempt(app) {
  const legacy = app.sockets[0];
  legacy.emit('connect');
  legacy.receive(authReply(-100));
  await new Promise(setImmediate);
  assert.equal(legacy.destroyed, true);
  assert.equal(app.sockets.length, 2);
  app.sockets[1].emit('connect');
  return app.sockets[1];
}

function unpackPassword(request, bytes) {
  const key = request.subarray(81, 97);
  const encrypted = request.subarray(97, 81 + bytes);
  const outer = crypto.createDecipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  const inner = crypto.createDecipheriv('aes-128-ecb', Buffer.from('macrovideo+*#!^@'), null).setAutoPadding(false);
  const intermediate = Buffer.concat([outer.update(encrypted), outer.final()]);
  return Buffer.concat([inner.update(intermediate), inner.final()]);
}

test('legacy login keeps its wire format and original password encoding', async () => {
  const app = await loadApp();
  app.sockets[0].emit('connect');
  const request = app.sockets[0].writes[0];
  assert.equal(request.length, 256);
  assert.equal(request.readUInt32LE(4), 1022);
  assert.equal(request[8], 2);
  assert.equal(request.readUInt32LE(13), Number(config.id));
  const expected = Buffer.alloc(16);
  expected.write(config.password);
  assert.deepEqual(unpackPassword(request, 32), expected);
  assert.ok(request.subarray(113).every(byte => byte === 0));
  app.sockets[0].receive(authReply());
  assert.equal(app.sockets.length, 2);
  assert.equal(app.fakeProcess.exitCode, 0);
});

test('protocol rejection triggers one newer login with a 64-byte password field', async () => {
  const app = await loadApp();
  const modern = await modernAttempt(app);
  const request = modern.writes[0];
  assert.equal(request.length, 520);
  assert.equal(request.readUInt32LE(4), 120);
  assert.equal(request[8], 31);
  assert.equal(request.subarray(49, 81).toString().replace(/\0+$/, ''), config.username);
  const expected = Buffer.alloc(48);
  expected.write(config.password);
  assert.deepEqual(unpackPassword(request, 64), expected);
  modern.receive(authReply(-100));
  await new Promise(setImmediate);
  assert.equal(modern.destroyed, true);
  assert.equal(app.sockets.length, 2);
  assert.equal(app.initialized.length, 0);
  assert.equal(app.fakeProcess.exitCode, 1);
});

test('credential errors stop; interrupted authentication retries without opening a stream', async () => {
  for (const result of [1011, 1012, 1018, 1900]) {
    const app = await loadApp();
    app.sockets[0].receive(authReply(1168, result));
    assert.equal(app.sockets.length, 1);
    assert.equal(app.sockets[0].destroyed, true);
    assert.equal(app.initialized.length, 0);
    assert.equal(app.fakeProcess.exitCode, 1);
    assert.equal(app.timers.length, 0);
  }
  for (const event of ['timeout', 'end', 'error']) {
    const app = await loadApp();
    app.sockets[0].emit(event, new Error('test error'));
    assert.equal(app.sockets[0].destroyed, true);
    assert.equal(app.fakeProcess.exitCode, 0);
    assert.equal(app.timers.length, 1);
    assert.equal(await app.retry(), 250);
    assert.equal(app.sockets.length, 2);
  }
});

test('fragmented newer replies preserve stream boundaries and use the new start flag', async () => {
  const app = await loadApp();
  const modern = await modernAttempt(app);
  const auth = authReply(1168, 1001, 31);
  for (let offset = 0; offset < auth.length; offset += 7) modern.receive(auth.subarray(offset, offset + 7));
  assert.equal(app.sockets.length, 3);
  const socket = app.sockets[2];
  socket.emit('connect');
  assert.equal(socket.writes[0].readUInt32LE(14), 42);
  const reply = Buffer.alloc(32);
  reply.writeInt32LE(401, 0);
  reply.writeInt32LE(1001, 4);
  reply.writeUInt16LE(20, 8);
  reply.writeUInt32LE(1920, 10);
  reply.writeUInt32LE(1080, 14);
  socket.receive(reply.subarray(0, 18), 'readable');
  assert.equal(socket.writes.length, 1);
  socket.receive(reply.subarray(18), 'readable');
  assert.equal(socket.writes.length, 2);
  const expected = Buffer.alloc(256);
  expected.writeUInt32LE(303, 0);
  expected.writeUInt32LE(0x3001, 4);
  assert.deepEqual(socket.writes[1], expected);
  assert.equal(app.initialized.length, 1);
  assert.equal(app.initialized[0][2].version, 31);
});

test('zero-sized video metadata never initializes camera media', async () => {
  const app = await loadApp();
  app.sockets[0].receive(authReply());
  const socket = app.sockets[1];
  socket.emit('connect');
  const reply = Buffer.alloc(18);
  reply.writeInt32LE(401, 0);
  reply.writeInt32LE(-11, 4);
  socket.receive(reply, 'readable');
  assert.equal(socket.destroyed, true);
  assert.equal(socket.writes.length, 1);
  assert.equal(app.initialized.length, 0);
});

test('audio-only session accepts zero video dimensions while preserving the verified wire request', async () => {
  const app = await loadApp(Date, [], {garage: {...config, serverPort: undefined, audioOnly: true}});
  const modern = await modernAttempt(app);
  modern.receive(authReply(1168, 1001, 31));
  const stream = app.sockets.at(-1); stream.emit('connect');
  assert.equal(stream.writes[0].readUInt32LE(22), 4097);
  const metadata = Buffer.alloc(32);
  metadata.writeInt32LE(401); metadata.writeInt32LE(1001, 4); metadata.writeUInt16LE(20, 8);
  stream.receive(metadata, 'readable');
  assert.equal(stream.destroyed, false);
  assert.equal(app.initialized.length, 1);
  assert.equal(stream.writes[1].readUInt32LE(0), 303);
});

async function openModernStream(app, ticket = 42, socket = undefined) {
  const auth = socket || await modernAttempt(app);
  const reply = authReply(1168, 1001, 31); reply.writeUInt32LE(ticket, 13);
  auth.receive(reply);
  const stream = app.sockets[app.sockets.length - 1]; stream.emit('connect');
  const metadata = Buffer.alloc(32);
  metadata.writeInt32LE(401); metadata.writeInt32LE(1001, 4);
  metadata.writeUInt16LE(20, 8); metadata.writeUInt32LE(1920, 10); metadata.writeUInt32LE(1080, 14);
  stream.receive(metadata, 'readable');
  return stream;
}

test('two cameras keep protocol selection, retries, and resets independent on one HTTP listener', async () => {
  const other = {id: '987654321', ip: '127.0.0.2', username: 'other', password: 'another-password'};
  const app = await loadApp(Date, [], {front_door: other});
  assert.equal(app.sockets.length, 2);
  assert.equal(app.bindings.length, 1);
  const garageAuth = app.sockets[0], frontAuth = app.sockets[1];
  garageAuth.emit('connect'); garageAuth.receive(authReply(-100));
  const garageModern = app.sockets.at(-1); garageModern.emit('connect');
  const garage = await openModernStream(app, 77, garageModern);
  frontAuth.emit('connect');
  assert.equal(frontAuth.writes[0].length, 256);
  assert.equal(frontAuth.writes[0].readUInt32LE(13), Number(other.id));
  frontAuth.receive(authReply());
  const front = app.sockets.at(-1); front.emit('connect');
  const metadata = Buffer.alloc(18);
  metadata.writeInt32LE(401); metadata.writeInt32LE(1001, 4);
  metadata.writeUInt16LE(20, 8); metadata.writeUInt32LE(640, 10); metadata.writeUInt32LE(480, 14);
  front.receive(metadata, 'readable');
  assert.equal(app.initialized.length, 2);
  garage.emit('timeout'); await new Promise(setImmediate);
  assert.deepEqual(app.resets, ['garage']);
  assert.equal(front.destroyed, false);
  assert.equal(await app.retry(), 250);
  const retry = app.sockets.at(-1); retry.emit('connect');
  assert.equal(retry.writes[0].length, 520);
  retry.destroy(new Error('offline'));
  front.emit('timeout'); await new Promise(setImmediate);
  assert.deepEqual(app.timers.map(timer => timer.delay), [500, 250]);
  app.timers.splice(1, 1)[0].callback(); await new Promise(setImmediate);
  const frontRetry = app.sockets.at(-1); frontRetry.emit('connect');
  assert.equal(frontRetry.writes[0].length, 256);
  assert.equal(frontRetry.writes[0].readUInt32LE(13), Number(other.id));
  assert.equal(app.fakeProcess.exitCode, 0);
});

test('one camera rejecting credentials leaves the other camera running', async () => {
  const app = await loadApp(Date, [], {front_door: {id: '42', ip: '127.0.0.2', username: 'other', password: ''}});
  const good = app.sockets[1];
  app.sockets[0].receive(authReply(1168, 1012));
  assert.equal(app.fakeProcess.exitCode, 0);
  assert.equal(good.destroyed, false);
  const stream = await openModernStream(app, 78, good);
  assert.equal(stream.destroyed, false);
  assert.equal(app.initialized.length, 1);
  assert.ok(app.errors.some(error => error.includes('[garage]') && error.includes('password')));
});

test('speaker commands require a selection for multiple cameras and never start the HTTP server', async () => {
  const other = {id: '42', ip: '127.0.0.2', username: 'other', password: ''};
  const selected = await loadApp(Date, ['node', 'app.ts', 'speak', '--test', '--camera', 'front_door'], {front_door: other});
  assert.equal(selected.spoken[0][0].id, other.id);
  assert.deepEqual(Array.from(selected.spoken[0][1]), ['--test']);
  assert.equal(selected.bindings.length, 0);
  assert.equal(selected.sockets.length, 0);
  const missing = await loadApp(Date, ['node', 'app.ts', 'speak', '--test'], {front_door: other});
  assert.equal(missing.fakeProcess.exitCode, 1);
  assert.equal(missing.spoken.length, 0);
  assert.equal(missing.bindings.length, 0);
  assert.ok(missing.errors.some(error => error.includes('Select a camera')));
});

test('stream timeout/end/error/close schedules one retry with fresh auth and remembered protocol', async () => {
  for (const event of ['timeout', 'end', 'error', 'close']) {
    const app = await loadApp();
    const stream = await openModernStream(app);
    if (event === 'error') stream.destroy(new Error('connection reset'));
    else if (event === 'close') stream.destroy();
    else stream.emit(event);
    await new Promise(setImmediate);
    assert.equal(stream.destroyed, true);
    assert.equal(app.timers.length, 1);
    assert.equal(app.resets.length, 1);
    assert.equal(await app.retry(), 250);
    const auth = app.sockets.at(-1); auth.emit('connect');
    assert.equal(auth.writes[0].length, 520);
    const recovered = await openModernStream(app, 1234, auth);
    assert.equal(recovered.writes[0].readUInt32LE(14), 1234);
    assert.equal(app.initialized.length, 2);
    assert.equal(app.initialized[1][2].authTicket, 1234);
    assert.equal(app.timers.length, 0);
    assert.equal(app.fakeProcess.exitCode, 0);
  }
});

test('LAN reconnect attempts back off to five seconds without parallel retries', async () => {
  const app = await loadApp();
  for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
    const socket = app.sockets.at(-1);
    socket.destroy(new Error('camera offline'));
    socket.emit('timeout'); socket.emit('end'); // Duplicate failure signals.
    assert.equal(app.timers.length, 1);
    assert.equal(await app.retry(), delay);
  }
  assert.equal(app.sockets.length, 8);
  assert.equal(app.fakeProcess.exitCode, 0);
});

test('a stable recovered stream resets reconnect backoff to a quarter second', async () => {
  let now = 1000;
  const app = await loadApp({ now: () => now });
  let stream = await openModernStream(app);
  stream.destroy(); await new Promise(setImmediate);
  assert.equal(await app.retry(), 250);
  let auth = app.sockets.at(-1); auth.emit('connect');
  stream = await openModernStream(app, 123, auth);
  stream.destroy(); await new Promise(setImmediate);
  assert.equal(await app.retry(), 500);
  auth = app.sockets.at(-1); auth.emit('connect');
  stream = await openModernStream(app, 456, auth);
  now += 30001;
  stream.destroy(); await new Promise(setImmediate);
  assert.equal(app.timers[0].delay, 250);
});

test('repeated brief successful sessions cannot leave recovery waiting thirty seconds', async () => {
  const app = await loadApp();
  let stream = await openModernStream(app);
  for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
    stream.destroy();
    await new Promise(setImmediate);
    assert.equal(app.timers.length, 1);
    assert.equal(await app.retry(), delay);
    const auth = app.sockets.at(-1); auth.emit('connect');
    stream = await openModernStream(app, 123, auth);
  }
  assert.equal(app.initialized.length, 8);
  assert.equal(app.fakeProcess.exitCode, 0);
});

test('unknown packet framing reconnects immediately instead of skipping arbitrary payload chunks', async () => {
  const app = await loadApp();
  const stream = await openModernStream(app);
  const unknown = Buffer.alloc(12, 0x9c);
  stream.receive(unknown.subarray(0, 7), 'readable');
  await new Promise(setImmediate);
  assert.equal(stream.destroyed, false);
  stream.receive(unknown.subarray(7), 'readable');
  await new Promise(setImmediate);
  assert.equal(stream.destroyed, true);
  assert.equal(app.errors.filter(error => /packet marker 0x9c/.test(error)).length, 1);
  assert.equal(app.timers.length, 1);
  assert.equal(app.timers[0].delay, 250);
  assert.equal(stream.listenerCount('end'), 1);
  stream.emit('timeout');
  assert.equal(app.timers.length, 1);
});

test('malformed stream login reconnects instead of throwing from an event callback', async () => {
  const app = await loadApp(); app.sockets[0].receive(authReply());
  const socket = app.sockets[1]; socket.emit('connect');
  const reply = Buffer.alloc(18); reply.writeInt32LE(999);
  assert.doesNotThrow(() => socket.receive(reply, 'readable'));
  await new Promise(setImmediate);
  assert.equal(socket.destroyed, true);
  assert.equal(app.initialized.length, 0);
  assert.equal(app.timers.length, 1);
});

test('legacy stream-start bytes stay compatible for all accepted response codes', async () => {
  for (const result of [-11, -12, 402, 1001]) {
    const app = await loadApp();
    app.sockets[0].receive(authReply());
    const socket = app.sockets[1];
    socket.emit('connect');
    const expected = Buffer.from(socket.writes[0]);
    expected.writeInt32LE(303, 0);
    expected.writeInt32LE(result, 4);
    const reply = Buffer.alloc(18);
    reply.writeInt32LE(401, 0);
    reply.writeInt32LE(result, 4);
    reply.writeUInt16LE(20, 8);
    reply.writeUInt32LE(640, 10);
    reply.writeUInt32LE(480, 14);
    socket.receive(reply, 'readable');
    assert.deepEqual(socket.writes[1], expected);
    assert.equal(app.initialized.length, 1);
  }
});

function loadMedia(auth, ffmpegFactory, listenHost) {
  const routes = {}, listens = [];
  const createRouter = () => ({ get(url, handler) { routes[url] = handler; } });
  const express = () => ({ get() {}, use() {}, listen: (port, host) => listens.push({port, host}) });
  express.Router = createRouter;
  const context = { exports: {}, Buffer, console: { log() {}, error() {} }, setTimeout,
    require(name) {
      if (name === 'express') return express;
      if (name === './socket') return socketContext.exports;
      if (name === './live') return liveContext.exports;
      if (name === 'fluent-ffmpeg' && ffmpegFactory) return ffmpegFactory;
      return require(name);
    },
  };
  const instrumented = streamSource.replace('return { init, reset, handleStream, router: app, serveLive };',
    'return { init, reset, handleStream, router: app, serveLive, decodeForTest: decodeVideoFrame, audioForTest: { decode: decodeAudioFrame, waveHeader: createAudioWaveHeader, streams: audStreams }, clientsForTest: { createStream, removeStream, video: vidStreams, cached: () => ({ iFrame, pFrame }) } };');
  assert.notEqual(instrumented, streamSource, 'Expected per-camera test instrumentation point');
  vm.runInNewContext(instrumented, context);
  const camera = context.exports.createStreamServer(4000, new Map([['camera', {}]]), listenHost).cameras.get('camera');
  context.exports = { init: (port, packet, auth) => camera.init(packet, auth), reset: camera.reset, handleStream: camera.handleStream };
  context.decodeForTest = camera.decodeForTest; context.audioForTest = camera.audioForTest; context.clientsForTest = camera.clientsForTest;
  routes['/live.flv'] = camera.serveLive;
  context.routesForTest = routes; context.listensForTest = listens;
  camera.init({ width: 1920, height: 1080, maybeFps: 20 }, auth);
  return context;
}

test('HTTP binds to loopback by default and only exposes other interfaces when configured', () => {
  const auth = { version: 31, authTicket: 42 };
  assert.deepEqual(loadMedia(auth).listensForTest, [{ port: 4000, host: '127.0.0.1' }]);
  for (const host of ['127.0.0.1', '0.0.0.0', '192.168.1.10', '::1', '::']) {
    assert.deepEqual(loadMedia(auth, undefined, host).listensForTest, [{ port: 4000, host }]);
  }
  for (const host of ['', null, 0, 'localhost', 'not-an-ip']) {
    assert.throws(() => loadMedia(auth, undefined, host), /serverHost must be/);
  }
});

test('configured serverHost is passed from config through camera login to the HTTP server', async () => {
  const app = await loadApp(Date, [], { serverHost: '0.0.0.0' });
  await openModernStream(app);
  assert.equal(app.bindings[0].host, '0.0.0.0');
});

test('FFmpeg internal audio follows wildcard, IPv6, and specific-interface bindings', async () => {
  const { PassThrough } = require('node:stream');
  for (const [host, expected] of [['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'], ['192.168.1.10', '192.168.1.10'], ['::1', '[::1]'], ['::', '[::1]']]) {
    const inputs = [];
    const command = new Proxy({}, { get(target, method) {
      return (...args) => { if (method === 'input') inputs.push(args[0]); return command; };
    } });
    const media = loadMedia({ version: 31, authTicket: 42 }, () => command, host);
    const response = new PassThrough(); response.contentType = () => {};
    media.routesForTest['/video/:filename']({}, response);
    assert.equal(inputs[1], `http://${expected}:4000/camera/audio/stream.wav`);
    response.destroy();
  }
  await new Promise(setImmediate);
});

test('firmware v31 decryption strips frame headers and preserves clear blocks and tails', () => {
  const key = Buffer.from('2a0000005c79142c46238161f00d8082', 'hex');
  const media = loadMedia({ version: 31, authTicket: 42 });
  for (const length of [0, 15, 16, 63, 64, 79, 80, 143, 144, 160, 257]) {
    const plain = Buffer.from(Array.from({ length }, (_, index) => index % 256));
    const encrypted = Buffer.from(plain);
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
    for (let offset = 0; offset + 64 <= length; offset += 80) {
      cipher.update(plain.subarray(offset, offset + 64)).copy(encrypted, offset);
    }
    cipher.final();
    const frame = Buffer.concat([Buffer.alloc(16, 0xff), encrypted]);
    assert.deepEqual(media.decodeForTest(frame), plain);
    assert.deepEqual(frame.subarray(16), encrypted);
  }
  assert.throws(() => media.decodeForTest(Buffer.alloc(15)), /16-byte header/);
});

test('legacy video stays unchanged and disconnected payload readers stop', async () => {
  const media = loadMedia({ version: 2, authTicket: 42 });
  const frame = Buffer.from('000000016764', 'hex');
  assert.strictEqual(media.decodeForTest(frame), frame);
  const header = Buffer.alloc(12);
  header[0] = 0x7f;
  header.writeUInt16LE(1, 3);
  header.writeUInt16LE(5, 7);
  const socket = new FakeSocket();
  socket.destroy();
  await assert.rejects(media.exports.handleStream(header, socket), /closed connection/);
});

function encryptAudio(blocks) {
  const key = Buffer.from('2a0000005c79142c46238161f00d8082', 'hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  return Buffer.concat([Buffer.alloc(16), cipher.update(blocks), cipher.final()]);
}

test('encrypted audio keeps each IMA predictor header and decrypts complete blocks', async () => {
  const media = loadMedia({ version: 31, authTicket: 42 });
  const blocks = Buffer.alloc(512);
  blocks.writeInt16LE(1000, 0);
  blocks[2] = 30;
  blocks.writeInt16LE(-1000, 256);
  blocks[258] = 50;
  const frame = encryptAudio(blocks);
  assert.deepEqual(media.audioForTest.decode(frame), blocks);

  const received = [];
  media.audioForTest.streams.push({ stream: { write: data => received.push(data) } });
  for (const [index, payload] of [frame.subarray(0, 400), frame.subarray(400)].entries()) {
    const header = Buffer.alloc(12);
    header[0] = 0x7f;
    header[1] = 0x16;
    header.writeUInt16LE(2, 3);
    header.writeUInt16LE(index, 5);
    header.writeUInt16LE(payload.length, 7);
    const socket = new FakeSocket();
    socket.buffer = payload;
    await media.exports.handleStream(header, socket);
  }
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], blocks);
});

test('audio rejects malformed encrypted blocks and preserves legacy extraction', () => {
  const modern = loadMedia({ version: 31, authTicket: 42 });
  assert.throws(() => modern.audioForTest.decode(Buffer.alloc(16)), /256-byte/);
  assert.throws(() => modern.audioForTest.decode(Buffer.alloc(271)), /256-byte/);
  for (const [index, reserved] of [[89, 0], [0, 1]]) {
    const block = Buffer.alloc(256);
    block[2] = index;
    block[3] = reserved;
    assert.throws(() => modern.audioForTest.decode(encryptAudio(block)), /block header/);
  }
  const legacy = loadMedia({ version: 2, authTicket: 42 });
  const frame = Buffer.concat([Buffer.alloc(20, 0xff), Buffer.from([1, 2, 3])]);
  assert.deepEqual(legacy.audioForTest.decode(frame), Buffer.from([1, 2, 3]));
});

test('FFmpeg decodes streaming IMA WAV blocks to the expected PCM samples', context => {
  const { spawnSync } = require('node:child_process');
  const media = loadMedia({ version: 31, authTicket: 42 });
  const block = Buffer.alloc(256);
  block.writeInt16LE(1000, 0);
  const input = Buffer.concat([media.audioForTest.waveHeader(), ...Array(8).fill(block)]);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'wav', '-ignore_length', '1', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], {
    input, windowsHide: true, timeout: 10000,
  });
  if (result.error && result.error.code === 'ENOENT') {
    context.skip('FFmpeg is not installed');
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, 8 * 505 * 2);
  for (let offset = 0; offset < result.stdout.length; offset += 2) {
    assert.equal(result.stdout.readInt16LE(offset), 1000);
  }
});

test('packet reads wait for exact bytes without polling and release listeners', async () => {
  const socket = new FakeSocket();
  const pending = readCameraBytes(socket, 12);
  socket.receive(Buffer.alloc(5, 1), 'readable');
  assert.equal(socket.readableLength, 5);
  socket.receive(Buffer.alloc(10, 2), 'readable');
  const result = await pending;
  assert.equal(result.length, 12);
  assert.equal(socket.readableLength, 3);
  for (const event of ['readable', 'end', 'close', 'error']) assert.equal(socket.listenerCount(event), 0);
  await assert.rejects(readCameraBytes(socket, 0), /Invalid camera packet read size/);
  const partial = new FakeSocket();
  partial.read = () => Buffer.alloc(3);
  await assert.rejects(readCameraBytes(partial, 12), /closed connection/);
  const broken = new FakeSocket();
  broken.read = () => { throw new Error('read failed'); };
  await assert.rejects(readCameraBytes(broken, 12), /read failed/);
  for (const source of [partial, broken]) {
    for (const event of ['readable', 'end', 'close', 'error']) assert.equal(source.listenerCount(event), 0);
  }
  for (const event of ['end', 'close', 'error']) {
    const closed = new FakeSocket();
    const read = readCameraBytes(closed, 12);
    closed.emit(event, new Error('test error'));
    await assert.rejects(read, /closed connection|test error/);
    for (const name of ['readable', 'end', 'close', 'error']) assert.equal(closed.listenerCount(name), 0);
  }
});

async function feedVideo(media, type, number) {
  const header = Buffer.alloc(12);
  header[0] = 0x7f;
  header[1] = type;
  header.writeUInt16LE(1, 3);
  header.writeUInt16LE(2, 7);
  const socket = new FakeSocket();
  socket.buffer = Buffer.alloc(2);
  socket.buffer.writeUInt16LE(number);
  await media.exports.handleStream(header, socket);
}

test('new clients wait for a keyframe and cached replay stays continuous', async () => {
  const media = loadMedia({ version: 2, authTicket: 42 });
  const client = media.clientsForTest.createStream(media.clientsForTest.video);
  const received = [];
  client.stream.on('data', data => received.push(data.readUInt16LE()));
  await feedVideo(media, 1, 99);
  assert.equal(received.length, 0);
  await feedVideo(media, 0, 0);
  for (let index = 1; index <= 40; index++) await feedVideo(media, 1, index);
  assert.deepEqual(received, Array.from({ length: 41 }, (_, index) => index));
  const cache = media.clientsForTest.cached();
  assert.equal(cache.iFrame.readUInt16LE(), 0);
  assert.deepEqual(Array.from(cache.pFrame, frame => frame.readUInt16LE()), received.slice(1));
  for (let index = 41; index <= 201; index++) await feedVideo(media, 1, index);
  assert.equal(media.clientsForTest.cached().iFrame, undefined);
  assert.equal(media.clientsForTest.cached().pFrame.length, 0);
  const waiting = media.clientsForTest.createStream(media.clientsForTest.video);
  await feedVideo(media, 1, 202);
  assert.equal(waiting.stream.readableLength, 0);
  await feedVideo(media, 0, 203);
  assert.equal(waiting.stream.read().readUInt16LE(), 203);
  media.clientsForTest.removeStream(client);
  media.clientsForTest.removeStream(waiting);
});

test('disconnected and slow video clients are removed without affecting others', async () => {
  const media = loadMedia({ version: 2, authTicket: 42 });
  const clients = media.clientsForTest;
  const gone = clients.createStream(clients.video);
  const slow = clients.createStream(clients.video);
  const active = clients.createStream(clients.video);
  clients.removeStream(gone);
  clients.removeStream(gone);
  assert.equal(gone.stream.destroyed, true);
  assert.equal(clients.video.length, 2);
  Object.defineProperty(slow.stream, 'writableLength', { value: 8 * 1024 * 1024 });
  await feedVideo(media, 0, 123);
  assert.equal(slow.stream.destroyed, true);
  assert.equal(clients.video.length, 1);
  assert.strictEqual(clients.video[0], active);
  assert.equal(active.stream.read().readUInt16LE(), 123);
  clients.removeStream(active);
});

test('session reset drops partial fragments/cached video, closes old feeds, and binds HTTP only once', async () => {
  const media = loadMedia({ version: 2, authTicket: 42 });
  await feedVideo(media, 0, 100);
  const client = media.clientsForTest.createStream(media.clientsForTest.video);
  const audio = media.clientsForTest.createStream(media.audioForTest.streams);
  const fragment = Buffer.alloc(12); fragment[0] = 0x7f;
  fragment.writeUInt16LE(2, 3); fragment.writeUInt16LE(2, 7);
  const partial = new FakeSocket(); partial.buffer = Buffer.from([255, 255]);
  await media.exports.handleStream(fragment, partial);
  media.exports.reset();
  assert.equal(client.stream.destroyed, true);
  assert.equal(audio.stream.destroyed, true);
  assert.equal(media.clientsForTest.cached().iFrame, undefined);
  media.exports.init(4000, { width: 640, height: 480, maybeFps: 20 }, { version: 2, authTicket: 123 });
  const recovered = media.clientsForTest.createStream(media.clientsForTest.video);
  await feedVideo(media, 0, 7);
  const frame = recovered.stream.read();
  assert.equal(frame.length, 2);
  assert.equal(frame.readUInt16LE(), 7);
  assert.deepEqual(media.listensForTest, [{ port: 4000, host: '127.0.0.1' }]);
  media.clientsForTest.removeStream(recovered);
});

test('internal audio feeds complete WAV blocks directly and releases disconnected clients', async () => {
  const { PassThrough } = require('node:stream');
  const media = loadMedia({ version: 31, authTicket: 42 }, () => {
    assert.fail('Internal audio must not start a second FFmpeg process');
  });
  const response = new PassThrough();
  let contentType;
  response.contentType = type => { contentType = type; };
  const chunks = [];
  response.on('data', data => chunks.push(data));
  media.routesForTest['/audio/:filename']({ params: { filename: 'stream.wav' } }, response);
  const block = Buffer.alloc(256);
  block.writeInt16LE(1000);
  const frame = encryptAudio(block);
  const packet = Buffer.alloc(12);
  packet[0] = 0x7f;
  packet[1] = 0x16;
  packet.writeUInt16LE(1, 3);
  packet.writeUInt16LE(frame.length, 7);
  const socket = new FakeSocket();
  socket.buffer = frame;
  await media.exports.handleStream(packet, socket);
  await new Promise(setImmediate);
  assert.equal(contentType, 'audio/wav');
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([media.audioForTest.waveHeader(), block]));
  assert.equal(media.audioForTest.streams.length, 1);
  response.destroy();
  await new Promise(setImmediate);
  assert.equal(media.audioForTest.streams.length, 0);
});

test('video response closure removes its client even without an FFmpeg error', async () => {
  const { PassThrough } = require('node:stream');
  const command = new Proxy({}, { get(target, method) {
    if (method === 'pipe') return () => command;
    return () => command;
  } });
  const media = loadMedia({ version: 31, authTicket: 42 }, () => command);
  const response = new PassThrough();
  response.contentType = () => {};
  media.routesForTest['/video/:filename']({}, response);
  assert.equal(media.clientsForTest.video.length, 1);
  const client = media.clientsForTest.video[0];
  response.destroy();
  await new Promise(setImmediate);
  assert.equal(media.clientsForTest.video.length, 0);
  assert.equal(client.stream.destroyed, true);
});

test('fast endpoint carries decrypted video/audio directly without an FFmpeg process', async () => {
  const { PassThrough } = require('node:stream');
  const media = loadMedia({ version: 31, authTicket: 42 }, () => {
    assert.fail('Fast playback must not start FFmpeg');
  });
  const response = new PassThrough(), chunks = [], headers = {};
  response.contentType = type => { headers.type = type; };
  response.setHeader = (key, value) => { headers[key] = value; };
  response.on('data', data => chunks.push(data));
  media.routesForTest['/live.flv']({}, response);
  async function feed(type, frame) {
    const header = Buffer.alloc(12);
    header[0] = 0x7f; header[1] = type;
    header.writeUInt16LE(1, 3); header.writeUInt16LE(frame.length, 7);
    const socket = new FakeSocket(); socket.buffer = frame;
    await media.exports.handleStream(header, socket);
  }
  const video = Buffer.concat([Buffer.alloc(16), Buffer.from('000000016742001e00000168ce00000001658812', 'hex')]);
  video.writeUInt32LE(1000, 8);
  await feed(0, video); // Under 64 bytes: video payload remains clear on this firmware.
  const audio = encryptAudio(Buffer.alloc(256)); audio.writeUInt32LE(1063, 8);
  await feed(0x16, audio);
  const data = Buffer.concat(chunks);
  assert.equal(headers.type, 'flv');
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(data.subarray(0, 3).toString(), 'FLV');
  let offset = 13, packets = [];
  while (offset < data.length) {
    const size = data.readUIntBE(offset + 1, 3);
    packets.push([data[offset], data.readUIntBE(offset + 4, 3), size]);
    offset += size + 15;
  }
  assert.deepEqual(packets.map(([type, time]) => [type, time]), [[8, 0], [9, 0], [9, 0], [8, 63]]);
  assert.equal(packets[3][2], 506);
  response.destroy();
});
