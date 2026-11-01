require('ts-node/register');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { createStreamServer } = require('../src/stream');

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for camera data');
    await delay(10);
  }
}

function encryptedFrame(payload, ticket, timestamp, audio = false) {
  const key = Buffer.from('000000005c79142c46238161f00d8082', 'hex');
  key.writeUInt32LE(ticket);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  let encoded;
  if (audio) encoded = Buffer.concat([cipher.update(payload), cipher.final()]);
  else {
    encoded = Buffer.from(payload);
    for (let offset = 0; offset + 64 <= payload.length; offset += 80) cipher.update(payload.subarray(offset, offset + 64)).copy(encoded, offset);
    cipher.final();
  }
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(BigInt(timestamp), 8);
  return Buffer.concat([header, encoded]);
}

function video(marker) {
  return Buffer.concat([Buffer.from('000000016742001e00000168ce0000000165', 'hex'), Buffer.alloc(900, marker)]);
}

function fragments(type, frame) {
  const packets = [];
  for (let offset = 0; offset < frame.length; offset += 500) {
    const data = frame.subarray(offset, offset + 500), header = Buffer.alloc(12);
    header[0] = 0x7f; header[1] = type;
    header.writeUInt16LE(Math.ceil(frame.length / 500), 3);
    header.writeUInt16LE(offset / 500, 5);
    header.writeUInt16LE(data.length, 7);
    packets.push({header, data});
  }
  return packets;
}

async function feed(camera, packet) {
  const input = new PassThrough();
  input.end(packet.data);
  await camera.handleStream(packet.header, input);
}

async function open(url, flv = true) {
  return new Promise((resolve, reject) => {
    const request = http.get(url);
    request.once('error', reject);
    request.once('response', response => {
      const result = {request, response, chunks: [], tags: [], closed: false};
      let pending = Buffer.alloc(0), header = true;
      response.on('error', () => {});
      response.once('close', () => { result.closed = true; });
      response.on('data', data => {
        result.chunks.push(data);
        if (!flv || response.statusCode !== 200) return;
        pending = Buffer.concat([pending, data]);
        if (header) {
          if (pending.length < 13) return;
          assert.equal(pending.subarray(0, 3).toString(), 'FLV');
          pending = pending.subarray(13); header = false;
        }
        while (pending.length >= 15) {
          const length = pending.readUIntBE(1, 3);
          if (pending.length < length + 15) break;
          result.tags.push({type: pending[0], time: pending.readUIntBE(4, 3) + pending[7] * 0x1000000, payload: pending.subarray(11, length + 11)});
          pending = pending.subarray(length + 15);
        }
      });
      resolve(result);
    });
  });
}

test('one HTTP server isolates named streams, AES keys, fragments, audio feeds, and reconnect resets', {timeout: 10000}, async t => {
  const bridge = createStreamServer(0, new Map([['garage', {}], ['front_door', {}]]));
  const viewers = [];
  t.after(async () => {
    for (const viewer of viewers) { viewer.response.destroy(); viewer.request.destroy(); }
    bridge.server.closeAllConnections();
    await new Promise(resolve => bridge.server.close(resolve));
  });
  await once(bridge.server, 'listening');
  assert.equal(bridge.server.address().address, '127.0.0.1');
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  const garage = bridge.cameras.get('garage'), front = bridge.cameras.get('front_door');
  for (const [path, status] of [['/live.flv', 404], ['/missing.flv', 404], ['/garage.flv', 503]]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  garage.init({width: 1920, height: 1080, maybeFps: 20}, {version: 31, authTicket: 42});
  front.init({width: 1280, height: 720, maybeFps: 20}, {version: 31, authTicket: 77});
  const a = await open(origin + '/garage.flv'), b = await open(origin + '/front_door.flv');
  const aAudio = await open(origin + '/garage/audio/stream.wav', false), bAudio = await open(origin + '/front_door/audio/stream.wav', false);
  viewers.push(a, b, aAudio, bAudio);
  const packets = [fragments(0, encryptedFrame(video(0x33), 42, 1000)), fragments(0, encryptedFrame(video(0x55), 77, 900000))];
  for (let index = 0; index < packets[0].length; index++) {
    await feed(garage, packets[0][index]);
    await feed(front, packets[1][index]);
  }
  const blocks = [Buffer.alloc(512), Buffer.alloc(512)];
  for (let offset = 0; offset < 512; offset += 256) { blocks[0].writeInt16LE(1000, offset); blocks[1].writeInt16LE(-1000, offset); }
  const audio = [fragments(0x16, encryptedFrame(blocks[0], 42, 1063, true)), fragments(0x16, encryptedFrame(blocks[1], 77, 900063, true))];
  for (let index = 0; index < audio[0].length; index++) {
    await feed(garage, audio[0][index]); await feed(front, audio[1][index]);
  }
  await until(() => [a,b].every(viewer => viewer.tags.some(tag => tag.type === 8 && tag.payload.length > 2)));
  for (const [viewer, marker, sample] of [[a, 0x33, 0xce], [b, 0x55, 0x4e]]) {
    const frame = viewer.tags.find(tag => tag.type === 9 && tag.payload[1] === 1);
    assert.ok(frame.payload.includes(Buffer.alloc(100, marker)));
    const audio = viewer.tags.find(tag => tag.type === 8 && tag.payload.length > 2);
    assert.equal(audio.time, 63);
    assert.ok(audio.payload.subarray(1).every(byte => byte === sample));
  }
  await until(() => Buffer.concat(aAudio.chunks).length >= 572 && Buffer.concat(bAudio.chunks).length >= 572);
  assert.deepEqual(Buffer.concat(aAudio.chunks).subarray(60), blocks[0]);
  assert.deepEqual(Buffer.concat(bAudio.chunks).subarray(60), blocks[1]);
  const frontCount = b.tags.length;
  garage.reset();
  await until(() => aAudio.closed);
  assert.equal(bAudio.closed, false);
  assert.equal(a.closed, false);
  assert.equal(b.closed, false);
  garage.init({width: 1920, height: 1080, maybeFps: 20}, {version: 31, authTicket: 99});
  for (const packet of fragments(0, encryptedFrame(video(0x66), 99, 10))) await feed(garage, packet);
  for (const packet of fragments(0, encryptedFrame(video(0x55), 77, 900100))) await feed(front, packet);
  await until(() => a.tags.some(tag => tag.payload.includes(Buffer.alloc(100, 0x66))) && b.tags.length > frontCount);
  assert.ok(a.tags.at(-1).time > 63);
  assert.equal(b.tags.at(-1).time, 100);
  assert.ok(b.tags.at(-1).payload.includes(Buffer.alloc(100, 0x55)));
});

test('audio-only camera drains unusable video and serves audio before any keyframe on both URLs', {timeout: 10000}, async t => {
  const bridge = createStreamServer(0, new Map([['garage', {audioOnly: true}], ['front_door', {}]]));
  const viewers = [];
  t.after(async () => {
    for (const viewer of viewers) { viewer.response.destroy(); viewer.request.destroy(); }
    bridge.server.closeAllConnections();
    await new Promise(resolve => bridge.server.close(resolve));
  });
  await once(bridge.server, 'listening');
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  const garage = bridge.cameras.get('garage'), front = bridge.cameras.get('front_door');
  garage.init({width: 0, height: 0, maybeFps: 20}, {version: 31, authTicket: 42});
  front.init({width: 1280, height: 720, maybeFps: 20}, {version: 31, authTicket: 77});
  const main = await open(origin + '/garage.flv'), audio = await open(origin + '/garage/audio.flv');
  const fullCameraAudio = await open(origin + '/front_door/audio.flv');
  viewers.push(main, audio, fullCameraAudio);
  const disabled = await fetch(origin + '/garage/video/stream.flv');
  assert.equal(disabled.status, 404); await disabled.arrayBuffer();
  for (const packet of fragments(0, Buffer.alloc(1))) await feed(garage, packet); // Invalid encrypted video would normally abort session.
  const pcm = Buffer.alloc(256); pcm.writeInt16LE(1000);
  for (const packet of fragments(0x16, encryptedFrame(pcm, 42, 9000, true))) await feed(garage, packet);
  for (const packet of fragments(0x16, encryptedFrame(pcm, 77, 2000, true))) await feed(front, packet);
  await until(() => viewers.every(viewer => viewer.tags.length));
  for (const viewer of viewers) {
    assert.equal(Buffer.concat(viewer.chunks)[4], 4);
    assert.equal(viewer.tags.length, 1);
    assert.equal(viewer.tags[0].type, 8);
    assert.equal(viewer.tags[0].payload.length, 506);
  }
  garage.reset();
  garage.init({width: 0, height: 0, maybeFps: 20}, {version: 31, authTicket: 99});
  for (const packet of fragments(0x16, encryptedFrame(pcm, 99, 10, true))) await feed(garage, packet);
  await until(() => main.tags.length === 2 && audio.tags.length === 2);
  assert.ok(main.tags[1].time > main.tags[0].time);
  assert.equal(fullCameraAudio.tags.length, 1);
});
