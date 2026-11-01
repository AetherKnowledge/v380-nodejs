require('ts-node/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { ImaEncoder, decodeImaWave } = require('../src/ima');
const { createLoginRequest } = require('../src/auth');
const { speakerHandshake, speakerPacket, sendPcm, waveInput, runSpeak } = require('../src/speak');

function wave(pcm, extra = Buffer.alloc(0)) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + extra.length + pcm.length, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header.subarray(0, 36), extra, header.subarray(36), pcm]);
}

test('speaker handshake and packet bytes match the Python protocol, including AES and sequence wrap', () => {
  const handshake = speakerHandshake('123456789', 0x12345678);
  assert.equal(handshake.length, 85);
  assert.equal(handshake.subarray(0, 12).toString('hex'), '7901000015cd5b0778563412');
  assert.ok(handshake.subarray(12).every(byte => byte === 0));
  const block = Buffer.alloc(256, 0x23);
  const legacy = speakerPacket(block, 0, 3, 42);
  assert.equal(legacy.subarray(0, 16).toString('hex'), 'b4000000010016000000000000000101');
  assert.deepEqual(legacy.subarray(16), block);
  const modern = speakerPacket(block, 255, 31, 42);
  assert.equal(modern.length, 272);
  assert.equal(modern[15], 0);
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('2a0000005c79142c46238161f00d8082', 'hex'), null).setAutoPadding(false);
  assert.deepEqual(Buffer.concat([decipher.update(modern.subarray(16)), decipher.final()]), block);
  assert.throws(() => speakerPacket(Buffer.alloc(255), 0, 31, 42), /Invalid/);
  assert.throws(() => speakerHandshake('invalid', 42), /device ID/);
  assert.throws(() => createLoginRequest({ id: '0', username: 'admin', password: '' }), /device ID/);
});

test('IMA encoder preserves predictor samples, pads the tail, and produces FFmpeg-decodable audio', t => {
  const encoder = new ImaEncoder(), constant = Buffer.alloc(1010);
  for (let i = 0; i < 505; i++) constant.writeInt16LE(1000, i * 2);
  assert.deepEqual(decodeImaWave(encoder.encode(constant)), constant);
  assert.equal(encoder.encode(Buffer.alloc(2)).length, 256);
  assert.throws(() => encoder.encode(Buffer.alloc(3)), /16-bit/);
  assert.throws(() => encoder.encode(Buffer.alloc(1012)), /505/);
  const pcm = Buffer.alloc(1010 * 12), frames = [], voice = new ImaEncoder();
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i * Math.PI * 2 * 440 / 8000)), i * 2);
  for (let offset = 0; offset < pcm.length; offset += 1010) frames.push(voice.encode(pcm.subarray(offset, offset + 1010)));
  const decoded = decodeImaWave(Buffer.concat(frames));
  let error = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) error += Math.abs(pcm.readInt16LE(offset) - decoded.readInt16LE(offset));
  assert.ok(error / (pcm.length / 2) < 350, 'Speech-band encoding error too high');
  const header = Buffer.alloc(48), payload = Buffer.concat(frames);
  header.write('RIFF'); header.writeUInt32LE(40 + payload.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(20, 16); header.writeUInt16LE(17, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(4055, 28); header.writeUInt16LE(256, 32);
  header.writeUInt16LE(4, 34); header.writeUInt16LE(2, 36); header.writeUInt16LE(505, 38);
  header.write('data', 40); header.writeUInt32LE(payload.length, 44);
  const reference = spawnSync('ffmpeg', ['-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], { input: Buffer.concat([header, payload]), timeout: 10000, windowsHide: true });
  if (reference.error?.code === 'ENOENT') { t.diagnostic('FFmpeg unavailable; external decoder comparison skipped'); return; }
  assert.ifError(reference.error);
  assert.equal(reference.status, 0, reference.stderr.toString());
  assert.deepEqual(reference.stdout, decoded);
});

async function camera(t, options = {}) {
  const sockets = new Set(), requests = [], packets = [], times = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes = Buffer.alloc(0), speaking = false;
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      if (!speaking) {
        if (bytes.length < 9) return;
        if (bytes.readUInt32LE(0) === 1167) {
          const modern = bytes[8] === 31, length = modern ? 520 : 256;
          if (bytes.length < length) return;
          requests.push(bytes.subarray(0, length)); bytes = bytes.subarray(length);
          const reply = Buffer.alloc(17);
          reply.writeInt32LE(!modern && options.modern !== false && !options.result ? -100 : 1168);
          reply.writeInt32LE(options.result || 1001, 4); reply[12] = options.modern === false ? 3 : 31;
          reply.writeUInt32LE(42, 13);
          socket.write(reply.subarray(0, 5)); setImmediate(() => { if (!socket.destroyed) socket.write(reply.subarray(5)); });
          return;
        }
        if (bytes.length < 85) return;
        assert.deepEqual(bytes.subarray(0, 85), speakerHandshake('123456789', 42));
        bytes = bytes.subarray(85); speaking = true;
        if (options.reject) {
          const rejected = Buffer.alloc(4); rejected.writeInt32LE(-11);
          socket.write(rejected.subarray(0, 2));
          setTimeout(() => { if (!socket.destroyed) socket.write(rejected.subarray(2)); }, 10);
        } else if (options.disconnect) setTimeout(() => socket.destroy(), 550);
      }
      while (bytes.length >= 272) {
        packets.push(Buffer.from(bytes.subarray(0, 272))); times.push(performance.now()); bytes = bytes.subarray(272);
        options.onPacket?.(packets.length);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { conf: { id: '123456789', ip: '127.0.0.1', port: server.address().port, username: 'test-user', password: 'test-password' }, requests, packets, times };
}

test('modern speaker session reauthenticates, handles fragmented replies/input, paces packets, and pads final block', { timeout: 5000 }, async t => {
  const fixture = await camera(t);
  const pcm = Buffer.alloc(1010 * 3 + 2);
  const sent = await sendPcm(fixture.conf, () => Readable.from([pcm.subarray(0, 1), pcm.subarray(1, 777), pcm.subarray(777)]));
  assert.equal(sent, 4);
  assert.deepEqual(fixture.requests.map(p => p.length), [256, 520]);
  assert.equal(fixture.packets.length, 4);
  assert.deepEqual(fixture.packets.map(p => p[15]), [1, 2, 3, 4]);
  assert.ok(fixture.times[3] - fixture.times[0] >= 130, 'Packets must be paced, not uploaded as a burst');
  for (const packet of fixture.packets) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('2a0000005c79142c46238161f00d8082', 'hex'), null).setAutoPadding(false);
    assert.deepEqual(Buffer.concat([decipher.update(packet.subarray(16)), decipher.final()]), Buffer.alloc(256));
  }
});

test('legacy speaker sends clear ADPCM after successful authentication', async t => {
  const fixture = await camera(t, { modern: false });
  await sendPcm(fixture.conf, () => Readable.from([Buffer.alloc(1010)]));
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.packets[0].subarray(16), Buffer.alloc(256));
});

test('bad credentials and fragmented speaker rejection never start microphone capture', async t => {
  for (const options of [{ result: 1012 }, { reject: true }]) {
    const fixture = await camera(t, options);
    await assert.rejects(sendPcm(fixture.conf, () => assert.fail('Capture must not start after rejection')), /rejected/);
    assert.equal(fixture.packets.length, 0);
  }
});

test('disconnects stop a stalled input; cancellation stops packet transmission', { timeout: 5000 }, async t => {
  const gone = await camera(t, { disconnect: true });
  const stalled = new Readable({ read() {} });
  await assert.rejects(sendPcm(gone.conf, () => stalled), /closed/);
  assert.equal(stalled.destroyed, true);
  const stop = new AbortController();
  const cancelled = await camera(t, { onPacket: () => stop.abort(new Error('test stop')) });
  await assert.rejects(sendPcm(cancelled.conf, () => Readable.from([Buffer.alloc(1010 * 10)]), stop.signal), /test stop/);
  assert.equal(cancelled.packets.length, 1);
});

test('WAV reader accepts metadata and rejects wrong rates, truncation, and odd sample bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v380-wave-test-')), files = [];
  t.after(async () => { for (const file of files) await fs.unlink(file); await fs.rmdir(directory); });
  async function save(data) { const file = path.join(directory, files.length + '.wav'); files.push(file); await fs.writeFile(file, data); return file; }
  const pcm = Buffer.from([0, 0, 1, 0, 255, 127]);
  const extra = Buffer.from('4a554e4b010000000000', 'hex');
  const createInput = await waveInput(await save(wave(pcm, extra)));
  const chunks = []; for await (const chunk of createInput()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), pcm);
  const wrong = wave(pcm); wrong.writeUInt32LE(44100, 24);
  await assert.rejects(waveInput(await save(wrong)), /8000 Hz/);
  await assert.rejects(waveInput(await save(wave(pcm).subarray(0, 45))), /Truncated/);
  await assert.rejects(waveInput(await save(wave(Buffer.alloc(3)))), /complete PCM/);
});

test('microphone mode converts captured audio without opening a shell or needing a physical microphone in tests', async t => {
  const fixture = await camera(t);
  const childProcess = require('node:child_process');
  let captured;
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    captured = { binary, args, options };
    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.alloc(1010 * 2)]); child.stderr = new PassThrough(); child.exitCode = null;
    child.stdout.once('end', () => { child.exitCode = 0; child.emit('exit', 0); });
    child.kill = () => { child.exitCode = 0; return true; };
    return child;
  });
  await runSpeak(fixture.conf, ['--mic', 'test microphone']);
  assert.equal(captured.binary, 'ffmpeg');
  assert.ok(captured.args.includes(process.platform === 'win32' ? 'audio=test microphone' : 'test microphone'));
  assert.ok(captured.args.includes('8000') && captured.args.includes('pcm_s16le'));
  assert.equal(captured.options.shell, undefined);
  assert.equal(fixture.packets.length, 2);
});

test('microphone startup failure releases the speaker connection and reports the capture error', { timeout: 5000 }, async t => {
  const fixture = await camera(t);
  const childProcess = require('node:child_process');
  let captured, killed = false;
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} }); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = () => { killed = true; return true; }; captured = child;
    process.nextTick(() => child.emit('error', new Error('ffmpeg not found')));
    return child;
  });
  await assert.rejects(runSpeak(fixture.conf, ['--mic', 'test microphone']), /install FFmpeg/);
  assert.equal(captured.stdout.destroyed, true);
  assert.equal(killed, true);
  assert.equal(fixture.packets.length, 0);
});

test('speaker test converts default and explicit MP3 files before sending encrypted audio', async t => {
  const pcm = Buffer.alloc(1010 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(4000 * Math.sin(offset / 2 * 2 * Math.PI * 440 / 8000)), offset);
  const mp3 = spawnSync('ffmpeg', ['-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], { input: wave(pcm), windowsHide: true, timeout: 10000 });
  if (mp3.error?.code === 'ENOENT') { t.skip('FFmpeg unavailable'); return; }
  assert.ifError(mp3.error);
  assert.equal(mp3.status, 0, mp3.stderr.toString());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v380-speaker-test-'));
  const previous = process.cwd();
  t.after(async () => { process.chdir(previous); await fs.rm(directory, { recursive: true, force: true }); });
  process.chdir(directory);
  await fs.writeFile('test.mp3', mp3.stdout);
  const custom = path.join(directory, 'custom & audio.mp3');
  await fs.writeFile(custom, mp3.stdout);
  const temporaryOutputs = [];
  const childProcess = require('node:child_process'), realSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    assert.equal(options.shell, undefined);
    temporaryOutputs.push(args.at(-1));
    return realSpawn(binary, args, options);
  });
  for (const args of [['--test'], ['--test', custom]]) {
    const fixture = await camera(t);
    await runSpeak(fixture.conf, args);
    assert.ok(fixture.packets.length >= 2);
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('2a0000005c79142c46238161f00d8082', 'hex'), null).setAutoPadding(false);
    const block = Buffer.concat([decipher.update(fixture.packets[0].subarray(16)), decipher.final()]);
    assert.ok(decodeImaWave(block).some(byte => byte !== 0));
  }
  for (const output of temporaryOutputs) await assert.rejects(fs.access(path.dirname(output)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile('test.mp3'), mp3.stdout);
});

test('speaker test rejects missing files and decoder failures before camera login, cleaning temporary files', async t => {
  const fixture = await camera(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v380-speaker-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(runSpeak(fixture.conf, ['--test', path.join(directory, 'missing.mp3')]), { code: 'ENOENT' });
  const source = path.join(directory, 'bad.mp3');
  await fs.writeFile(source, 'invalid audio');
  let output;
  t.mock.method(require('node:child_process'), 'spawn', (binary, args) => {
    output = args.at(-1);
    const child = new EventEmitter();
    child.stderr = new PassThrough(); child.exitCode = null;
    process.nextTick(() => {
      child.stderr.write('invalid audio'); child.exitCode = 1; child.emit('close', 1);
    });
    return child;
  });
  await assert.rejects(runSpeak(fixture.conf, ['--test', source]), /Audio conversion failed: invalid audio/);
  await assert.rejects(fs.access(path.dirname(output)), { code: 'ENOENT' });
  assert.equal(fixture.requests.length, 0);
});
