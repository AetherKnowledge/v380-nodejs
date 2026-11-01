import { Readable } from 'stream';

// go2rtc 1.9.8 can retain the process until its WebRTC peer timeout expires.
// Close talk promptly when RTP stops, even if stdin remains open.
const AUDIO_IDLE_MS = 750;

// go2rtc exec backchannels negotiate PCMA/8000 with browser WebRTC clients.
export function decodeAlaw(bytes: Buffer): Buffer {
	const pcm = Buffer.alloc(bytes.length * 2);
	for (let i = 0; i < bytes.length; i++) {
		const value = bytes[i] ^ 0x55;
		const segment = (value >> 4) & 7;
		let sample = ((value & 15) << 4) + 8;
		if (segment) sample += 256;
		if (segment > 1) sample <<= segment - 1;
		pcm.writeInt16LE(value & 0x80 ? sample : -sample, i * 2);
	}
	return pcm;
}

// go2rtc may inspect the source before microphone audio arrives. Do not mute
// the camera by authenticating/opening its speaker until the first packet.
export async function alawInput(input: Readable, signal: AbortSignal): Promise<Readable | undefined> {
	signal.throwIfAborted();
	const iterator = input[Symbol.asyncIterator]();
	const cancelled = () => input.destroy(signal.reason);
	signal.addEventListener('abort', cancelled, { once: true });
	try {
		const first = await iterator.next();
		if (first.done) return;
		const output = Readable.from((async function* () {
			yield decodeAlaw(Buffer.from(first.value));
			while (true) {
				let idle = false;
				const timer = setTimeout(() => { idle = true; input.destroy(); }, AUDIO_IDLE_MS);
				let next: IteratorResult<Buffer>;
				try { next = await iterator.next(); }
				catch (error) { if (idle) return; throw error; }
				finally { clearTimeout(timer); }
				if (next.done) return;
				yield decodeAlaw(Buffer.from(next.value));
			}
		})());
		output.once('close', () => input.destroy());
		return output;
	} finally {
		signal.removeEventListener('abort', cancelled);
	}
}
