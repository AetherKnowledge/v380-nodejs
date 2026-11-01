require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { decodeAlaw, alawInput } = require('../src/backchannel');

test('go2rtc PCMA decoder matches FFmpeg for every possible code', t => {
  const codes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const pcm = decodeAlaw(codes);
  assert.equal(pcm.length, 512);
  assert.equal(decodeAlaw(Buffer.from([0xd5])).readInt16LE(), 8);
  assert.equal(decodeAlaw(Buffer.from([0x55])).readInt16LE(), -8);
  const reference = spawnSync('ffmpeg', ['-v', 'error', '-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], { input: codes, windowsHide: true, timeout: 10000 });
  if (reference.error?.code === 'ENOENT') { t.skip('FFmpeg not installed'); return; }
  assert.ifError(reference.error);
  assert.equal(reference.status, 0, reference.stderr.toString());
  assert.deepEqual(pcm, reference.stdout);
});

test('backchannel waits for the first packet and preserves fragmented PCMA input', async () => {
  const input = new PassThrough(), signal = new AbortController();
  let started = false;
  const pending = alawInput(input, signal.signal).then(value => { started = true; return value; });
  await new Promise(setImmediate);
  assert.equal(started, false, 'Idle go2rtc source must not open the camera speaker');
  input.write(Buffer.from([0xd5]));
  const output = await pending;
  input.end(Buffer.from([0x55, 0, 255]));
  const chunks = []; for await (const chunk of output) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), decodeAlaw(Buffer.from([0xd5, 0x55, 0, 255])));
  assert.equal(input.destroyed, true);
});

test('empty backchannels close without starting talk; abort unblocks an idle pipe', async () => {
  assert.equal(await alawInput(Readable.from([]), new AbortController().signal), undefined);
  const input = new PassThrough(), control = new AbortController();
  const pending = alawInput(input, control.signal);
  control.abort(new Error('talk released'));
  await assert.rejects(pending, /talk released/);
  assert.equal(input.destroyed, true);
});

test('closing a backchannel output also releases its input pipe', async () => {
  const input = new PassThrough(), control = new AbortController();
  const pending = alawInput(input, control.signal);
  input.write(Buffer.from([0xd5]));
  const output = await pending;
  output.destroy();
  await new Promise(setImmediate);
  assert.equal(input.destroyed, true);
});

test('stopped microphone packets end talk without waiting for go2rtc to close stdin', { timeout: 3000 }, async () => {
  const input = new PassThrough();
  const pending = alawInput(input, new AbortController().signal);
  input.write(Buffer.alloc(160, 0xd5));
  const output = await pending;
  const began = performance.now(), chunks = [];
  for await (const chunk of output) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 320);
  assert.equal(input.destroyed, true);
  assert.ok(performance.now() - began < 1500, 'Talk remained open after audio packets stopped');
});
