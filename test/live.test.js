const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const imaContext = { exports: {}, Buffer };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/ima.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, imaContext);
const context = { exports: {}, Buffer, require: name => name === './ima' ? imaContext.exports : require(name) };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/live.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, context);
const { LiveFlv, decodeImaWave, audioToMulaw, flvTag } = context.exports;

function ffmpeg(args, input, t) {
  const result = spawnSync('ffmpeg', ['-v', 'error', ...args], { input, windowsHide: true, timeout: 10000 });
  if (result.error?.code === 'ENOENT') { t.skip('FFmpeg is not installed'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('IMA WAV matches FFmpeg exactly; G.711 roundtrip stays within quantization error', t => {
  const blocks = Buffer.alloc(256 * 89);
  for (let index = 0; index <= 88; index++) {
    const offset = index * 256;
    blocks.writeInt16LE((index * 7919 % 65536) - 32768, offset);
    blocks[offset + 2] = index;
    for (let byte = 4; byte < 256; byte++) blocks[offset + byte] = (byte * 113 + index * 31) & 255;
  }
  // Ordinary WAV fixture, independent of production header builder.
  const header = Buffer.alloc(48);
  header.write('RIFF'); header.writeUInt32LE(40 + blocks.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(20, 16); header.writeUInt16LE(17, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(4055, 28); header.writeUInt16LE(256, 32);
  header.writeUInt16LE(4, 34); header.writeUInt16LE(2, 36); header.writeUInt16LE(505, 38);
  header.write('data', 40); header.writeUInt32LE(blocks.length, 44);
  const expected = ffmpeg(['-f', 'wav', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], Buffer.concat([header, blocks]), t);
  if (expected) {
    const actual = decodeImaWave(blocks);
    assert.ok(actual.equals(expected), 'IMA decoder samples must match FFmpeg');
    const decoded = ffmpeg(['-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], audioToMulaw(blocks), t);
    assert.equal(decoded.length, expected.length);
    for (let offset = 0; offset < expected.length; offset += 2) {
      const error = Math.abs(decoded.readInt16LE(offset) - expected.readInt16LE(offset));
      assert.ok(error <= 644, 'G.711 error exceeds quantization/clipping bound');
    }
  }
  assert.throws(() => audioToMulaw(Buffer.alloc(255)), /Invalid/);
  const invalid = Buffer.alloc(256); invalid[2] = 89;
  assert.throws(() => audioToMulaw(invalid), /predictor/);
});

function tags(chunks) {
  let data = Buffer.concat(chunks).subarray(13);
  const result = [];
  while (data.length) {
    const size = data.readUIntBE(1, 3);
    assert.ok(data.length >= size + 15);
    assert.equal(data.readUInt32BE(size + 11), size + 11);
    result.push({ type: data[0], time: data.readUIntBE(4, 3) + data[7] * 16777216, payload: data.subarray(11, 11 + size) });
    data = data.subarray(size + 15);
  }
  return result;
}
const key = Buffer.from('000000016742001e00000168ce00000001658812', 'hex');
const predicted = Buffer.from('000001419a12', 'hex');
function viewer(live) {
  const output = new PassThrough(), chunks = [];
  output.on('data', data => chunks.push(data));
  live.attach(output);
  return { output, chunks };
}

test('audio-only FLV starts on audio without a video keyframe and survives clock resets', t => {
  const live = new LiveFlv(true), first = viewer(live);
  assert.equal(Buffer.concat(first.chunks)[4], 4, 'FLV header must advertise only audio');
  live.video(Buffer.alloc(5), 800); // Irrelevant video must not be parsed.
  live.audio(Buffer.alloc(256), 1000);
  live.audio(Buffer.alloc(256), 1063);
  assert.deepEqual(tags(first.chunks).map(packet => [packet.type, packet.time]), [[8, 0], [8, 63]]);
  const decoded = ffmpeg(['-f', 'flv', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], Buffer.concat(first.chunks), t);
  if (decoded) assert.equal(decoded.length, 505 * 2 * 2);
  live.reset();
  live.audio(Buffer.alloc(256), 10);
  assert.equal(first.output.destroyed, false);
  assert.ok(tags(first.chunks).at(-1).time > 63);
  const late = viewer(live);
  live.audio(Buffer.alloc(256), 73);
  assert.deepEqual(tags(late.chunks).map(packet => [packet.type, packet.time]), [[8, 0]]);
  first.output.destroy(); late.output.destroy();
});

function controlledLive(audioOnly) {
  let now = 0;
  const timers = new Map();
  const fixture = {exports: {}, Buffer, require(name) {
    if (name === './ima') return imaContext.exports;
    if (name === 'perf_hooks') return {performance: {now: () => now}};
    if (name === 'timers') return {
      setInterval(callback) { const timer = {unref() {}}; timers.set(timer, callback); return timer; },
      clearInterval(timer) { timers.delete(timer); },
    };
    return require(name);
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/live.ts'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017},
  }).outputText, fixture);
  return {live: new fixture.exports.LiveFlv(audioOnly), timers, tick(time) {
    now = time;
    for (const callback of timers.values()) callback();
  }};
}

test('audio-only consumers receive paced silence before audio and across camera outages, then resume real samples', async () => {
  const clock = controlledLive(true), first = viewer(clock.live);
  assert.equal(clock.timers.size, 1);
  clock.tick(199);
  assert.equal(tags(first.chunks).length, 0);
  clock.tick(200);
  let packets = tags(first.chunks);
  assert.deepEqual(packets.map(packet => [packet.type, packet.time]), [[8, 0]]);
  assert.ok(packets[0].payload.subarray(1).every(byte => byte === 0xff));
  const pcm = Buffer.alloc(256); pcm.writeInt16LE(1000);
  clock.tick(264);
  clock.live.audio(pcm, 9000000);
  packets = tags(first.chunks);
  assert.ok(packets.at(-1).payload.subarray(1).every(byte => byte === 0xce));
  const before = packets.at(-1).time;
  clock.live.reset();
  clock.tick(1200);
  packets = tags(first.chunks);
  assert.ok(packets.at(-1).time > before);
  assert.ok(packets.at(-1).payload.subarray(1).every(byte => byte === 0xff));
  const beforeResume = packets.at(-1).time;
  clock.live.audio(pcm, 10); // Camera clock/session resets during outage.
  packets = tags(first.chunks);
  assert.ok(packets.at(-1).time > beforeResume);
  assert.ok(packets.at(-1).payload.subarray(1).every(byte => byte === 0xce));
  assert.equal(first.output.destroyed, false);
  first.output.destroy(); await new Promise(setImmediate);
  assert.equal(clock.timers.size, 0, 'No timer remains after last HTTP consumer disconnects');
});

test('full video feed keeps video and silent audio flowing during talk, dropping overlapping stale samples on return', async () => {
  const clock = controlledLive(false), first = viewer(clock.live);
  clock.live.video(key, 1000);
  clock.live.audio(Buffer.alloc(256), 1000);
  for (let time = 50; time <= 1000; time += 50) {
    clock.live.video(predicted, 1000 + time);
    clock.tick(time);
  }
  let packets = tags(first.chunks);
  assert.equal(packets.filter(packet => packet.type === 9).at(-1).time, 1000);
  const silent = packets.filter(packet => packet.type === 8 && packet.payload.length > 2);
  assert.ok(silent.length > 8);
  assert.ok(silent.at(-1).payload.subarray(1).every(byte => byte === 0xff));
  const count = packets.length;
  clock.live.audio(Buffer.alloc(256), 1063); // Buffered packet is older than filled silence.
  assert.equal(tags(first.chunks).length, count);
  const block = Buffer.alloc(256); block.writeInt16LE(1000);
  clock.live.audio(block, 2000);
  packets = tags(first.chunks);
  assert.equal(packets.at(-1).time, 1000);
  assert.ok(packets.at(-1).payload.subarray(1).every(byte => byte === 0xce));
  const audio = packets.filter(packet => packet.type === 8);
  assert.ok(audio.every((packet, index) => !index || packet.time >= audio[index - 1].time));
  first.output.destroy(); await new Promise(setImmediate);
  assert.equal(clock.timers.size, 0);
});

test('event-loop stalls and rapid buffered-audio bursts cannot create unbounded catch-up output', async () => {
  const clock = controlledLive(true), first = viewer(clock.live);
  clock.tick(200);
  const before = tags(first.chunks).length;
  clock.tick(60000);
  assert.ok(tags(first.chunks).length - before <= 4);
  for (let index = 0; index < 100; index++) clock.live.audio(Buffer.alloc(256), index * 63);
  assert.ok(tags(first.chunks).length - before <= 6);
  Object.defineProperty(first.output, 'writableLength', {value: 8 * 1024 * 1024});
  clock.tick(60500);
  assert.equal(first.output.destroyed, true);
  assert.equal(clock.timers.size, 0);
  await new Promise(setImmediate);
});

test('live A/V uses one camera clock, joins at keyframes, and sends G.711 at 8kHz', t => {
  const live = new LiveFlv();
  const first = viewer(live);
  live.video(predicted, 900);
  live.audio(Buffer.alloc(256), 950);
  assert.equal(tags(first.chunks).length, 0);
  live.video(key, 1000);
  live.audio(Buffer.alloc(256), 1063);
  live.video(predicted, 1125);
  const packets = tags(first.chunks);
  assert.deepEqual(packets.map(p => [p.type, p.time]), [[8, 0], [9, 0], [9, 0], [8, 63], [9, 125]]);
  assert.equal(packets[1].payload[5], 1); // AVCDecoderConfigurationRecord version
  assert.equal(packets[2].payload.readUInt32BE(5), 3); // Length-prefixed IDR NAL
  const audioFlv = Buffer.concat([Buffer.from('464c5601040000000900000000', 'hex'), flvTag(8, 0, packets[3].payload)]);
  const decoded = ffmpeg(['-f', 'flv', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], audioFlv, t);
  if (decoded) { assert.equal(decoded.length, 505 * 2); assert.ok(decoded.every(byte => byte === 0)); }
});

test('cached reference frames prime immediately without replaying old durations', () => {
  const live = new LiveFlv();
  live.video(key, 1000);
  live.video(predicted, 2000);
  live.video(predicted, 3000);
  const late = viewer(live);
  assert.deepEqual(tags(late.chunks).map(p => p.time), [0, 0, 0, 0, 0]);
  live.audio(Buffer.alloc(256), 2990); // Before join: discard.
  live.audio(Buffer.alloc(256), 3063);
  live.video(predicted, 3125);
  assert.deepEqual(tags(late.chunks).slice(-2).map(p => [p.type, p.time]), [[8, 63], [9, 125]]);
  late.output.destroy();
});

test('slow viewers are disconnected while healthy viewers continue; oversized caches wait for IDR', () => {
  const live = new LiveFlv();
  const slow = viewer(live), healthy = viewer(live);
  Object.defineProperty(slow.output, 'writableLength', { value: 8 * 1024 * 1024 });
  live.video(key, 1000);
  assert.equal(slow.output.destroyed, true);
  assert.equal(tags(healthy.chunks).length, 3);
  for (let i = 0; i < 201; i++) live.video(predicted, 1100 + i);
  const waiting = viewer(live);
  assert.equal(tags(waiting.chunks).length, 0);
  live.video(key, 2000);
  assert.equal(tags(waiting.chunks).length, 3);
  assert.throws(() => live.video(Buffer.alloc(4), 2100), /Annex B/);
});

test('FLV preserves timestamp extension and rejects invalid tag sizes/times', () => {
  const packet = flvTag(9, 0x12345678, Buffer.from([1, 2]));
  assert.equal(packet[7], 0x12);
  assert.equal(packet.readUIntBE(4, 3), 0x345678);
  assert.equal(packet.readUInt32BE(packet.length - 4), 13);
  assert.throws(() => flvTag(9, NaN, Buffer.alloc(0)), /Invalid/);
  assert.throws(() => flvTag(9, 0, Buffer.alloc(0x1000000)), /Invalid/);
});

test('live viewers survive reconnect, wait for fresh IDR, and keep timestamps advancing after camera clock resets', () => {
  let now = 10000;
  context.Date = { now: () => now };
  try {
    const live = new LiveFlv(), current = viewer(live);
    live.video(key, 100000); live.video(predicted, 100125);
    live.audio(Buffer.alloc(256), 100126);
    now += 6000;
    live.reset();
    const waiting = viewer(live);
    const previous = tags(current.chunks).length;
    live.video(predicted, 10); live.audio(Buffer.alloc(256), 20);
    assert.equal(tags(current.chunks).length, previous);
    assert.equal(tags(waiting.chunks).length, 0);
    live.video(key, 100); live.audio(Buffer.alloc(256), 163);
    const resumed = tags(current.chunks).slice(previous);
    assert.deepEqual(resumed.map(p => [p.type, p.time]), [[8, 6000], [9, 6000], [9, 6000], [8, 6063]]);
    assert.deepEqual(tags(waiting.chunks).map(p => [p.type, p.time]), [[8, 0], [9, 0], [9, 0], [8, 63]]);
    live.audio(Buffer.alloc(256), 90); // Late arrival from just before the new IDR.
    assert.equal(tags(current.chunks).at(-1).time, 6063);
    assert.equal(current.output.destroyed, false);
    assert.equal(Buffer.concat(current.chunks).indexOf('FLV', 3), -1, 'HTTP session must keep a single FLV header');
    current.output.destroy(); waiting.output.destroy();
  } finally { context.Date = Date; }
});
