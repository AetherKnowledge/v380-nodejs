import { Writable } from 'stream';

const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
	34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
	157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
	598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
	1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
	5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
	13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

// G.711 mu-law preserves the camera's 8 kHz mono rate. FLV and VLC support it
// directly, without AAC's encoder delay or a second process per viewer.
export function decodeImaWave(blocks: Buffer): Buffer {
	if (!blocks.length || blocks.length % 256) throw new Error('Invalid IMA WAV blocks');
	const result = Buffer.alloc(blocks.length / 256 * 505 * 2);
	let out = 0;
	const sample = (pcm: number) => { result.writeInt16LE(pcm, out); out += 2; };
	for (let offset = 0; offset < blocks.length; offset += 256) {
		let predictor = blocks.readInt16LE(offset);
		let index = blocks[offset + 2];
		if (index > 88 || blocks[offset + 3]) throw new Error('Invalid IMA WAV predictor');
		sample(predictor);
		for (let pos = offset + 4; pos < offset + 256; pos++) {
			for (const nibble of [blocks[pos] & 15, blocks[pos] >> 4]) {
				const step = STEP[index];
				// Round each contribution separately, as specified by IMA ADPCM.
				const delta = (step >> 3) + (nibble & 4 ? step : 0) +
					(nibble & 2 ? step >> 1 : 0) + (nibble & 1 ? step >> 2 : 0);
				predictor = Math.max(-32768, Math.min(32767, predictor + (nibble & 8 ? -delta : delta)));
				index = Math.max(0, Math.min(88, index + INDEX[nibble & 7]));
				sample(predictor);
			}
		}
	}
	return result;
}

export function audioToMulaw(blocks: Buffer): Buffer {
	const pcm = decodeImaWave(blocks);
	const result = Buffer.alloc(pcm.length / 2);
	for (let i = 0; i < result.length; i++) {
		const value = pcm.readInt16LE(i * 2);
		const sign = value < 0 ? 0x80 : 0;
		const magnitude = Math.min(Math.abs(value), 32635) + 132;
		let exponent = 7;
		for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent--;
		result[i] = ~(sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 15)) & 255;
	}
	return result;
}

function nals(frame: Buffer): Buffer[] {
	const result: Buffer[] = [];
	let start = -1;
	for (let i = 0; i + 2 < frame.length; i++) {
		if (frame[i] || frame[i + 1]) continue;
		const size = frame[i + 2] === 1 ? 3 : frame[i + 2] === 0 && frame[i + 3] === 1 ? 4 : 0;
		if (!size) continue;
		if (start >= 0 && i > start) result.push(frame.subarray(start, i));
		start = i + size;
		i += size - 1;
	}
	if (start >= 0 && start < frame.length) result.push(frame.subarray(start));
	if (!result.length || result.some(nal => nal[0] & 0x80)) throw new Error('Invalid Annex B video');
	return result;
}

function sized(nal: Buffer, bytes: number): Buffer {
	const size = Buffer.alloc(bytes);
	size.writeUIntBE(nal.length, 0, bytes);
	return Buffer.concat([size, nal]);
}

export function flvTag(type: number, timestamp: number, payload: Buffer): Buffer {
	if (payload.length > 0xffffff || !Number.isFinite(timestamp)) throw new Error('Invalid FLV tag');
	const tag = Buffer.alloc(payload.length + 15);
	tag[0] = type;
	tag.writeUIntBE(payload.length, 1, 3);
	const time = Math.max(0, Math.floor(timestamp)) >>> 0;
	tag.writeUIntBE(time & 0xffffff, 4, 3);
	tag[7] = time >>> 24;
	payload.copy(tag, 11);
	tag.writeUInt32BE(payload.length + 11, payload.length + 11);
	return tag;
}

interface Viewer { output: Writable; base?: number; videoTime: number; audioTime: number; joinedAt: number; offset: number; }
const MAX_BYTES = 8 * 1024 * 1024;

export class LiveFlv {
	private viewers = new Set<Viewer>();
	private config?: Buffer;
	private cache: Buffer[] = [];
	private cacheBytes = 0;
	private latest = 0;

	reset() {
		this.config = undefined;
		this.cache = [];
		this.cacheBytes = 0;
		this.latest = 0;
		for (const viewer of this.viewers) {
			viewer.base = undefined;
			viewer.offset = Math.max(viewer.videoTime, viewer.audioTime) + 1;
		}
	}

	attach(output: Writable) {
		const viewer: Viewer = { output, videoTime: 0, audioTime: 0, joinedAt: Date.now(), offset: 0 };
		this.viewers.add(viewer);
		output.once('close', () => this.viewers.delete(viewer));
		this.write(viewer, Buffer.from('464c5601050000000900000000', 'hex'));
		if (this.config && this.cache.length) {
			this.start(viewer, this.latest);
			this.write(viewer, flvTag(9, 0, this.config));
			// Prime decoder references at time zero, then start its live clock at
			// the newest frame. Replaying historical durations adds a whole GOP delay.
			for (const payload of this.cache) this.write(viewer, flvTag(9, 0, payload));
		}
	}

	private start(viewer: Viewer, timestamp: number) {
		if (viewer.offset) viewer.offset = Math.max(viewer.offset, Date.now() - viewer.joinedAt);
		viewer.base = timestamp - viewer.offset;
		viewer.videoTime = viewer.offset;
		viewer.audioTime = viewer.offset;
		// Announce audio before a large IDR exhausts the player's probe budget.
		// One mu-law silence sample (0.125 ms) declares the codec without delay.
		this.write(viewer, flvTag(8, viewer.offset, Buffer.from([0x82, 0xff])));
	}

	private write(viewer: Viewer, data: Buffer) {
		if (viewer.output.destroyed || viewer.output.writableLength + data.length > MAX_BYTES) {
			this.viewers.delete(viewer);
			viewer.output.destroy();
		} else viewer.output.write(data);
	}

	video(frame: Buffer, timestamp: number) {
		const units = nals(frame);
		const keyframe = units.some(nal => (nal[0] & 31) === 5);
		if (keyframe) {
			const sps = units.filter(nal => (nal[0] & 31) === 7);
			const pps = units.filter(nal => (nal[0] & 31) === 8);
			if (sps.length && pps.length) {
				if (sps[0].length < 4 || sps.length > 31 || pps.length > 255 || [...sps, ...pps].some(nal => nal.length > 65535)) {
					throw new Error('Invalid AVC parameter sets');
				}
				this.config = Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0, 1, sps[0][1], sps[0][2], sps[0][3], 255, 224 | sps.length]),
					...sps.map(nal => sized(nal, 2)), Buffer.from([pps.length]), ...pps.map(nal => sized(nal, 2))]);
			}
			this.cache = [];
			this.cacheBytes = 0;
		}
		if (!this.config) return;
		const payload = Buffer.concat([Buffer.from([keyframe ? 0x17 : 0x27, 1, 0, 0, 0]),
			...units.filter(nal => ![7, 8, 9].includes(nal[0] & 31)).map(nal => sized(nal, 4))]);
		this.latest = timestamp;
		if (keyframe || this.cache.length) {
			this.cacheBytes += payload.length;
			if (this.cacheBytes > MAX_BYTES || this.cache.length >= 200) this.cache = [];
			else this.cache.push(payload);
		}
		for (const viewer of this.viewers) {
			if (viewer.base === undefined) {
				if (!keyframe) continue;
				this.start(viewer, timestamp);
			}
			viewer.videoTime = Math.max(viewer.videoTime, timestamp - viewer.base!);
			if (keyframe) this.write(viewer, flvTag(9, viewer.videoTime, this.config));
			this.write(viewer, flvTag(9, viewer.videoTime, payload));
		}
	}

	audio(blocks: Buffer, timestamp: number) {
		if (!this.viewers.size) return;
		const payload = Buffer.concat([Buffer.from([0x82]), audioToMulaw(blocks)]);
		for (const viewer of this.viewers) {
			if (viewer.base === undefined || timestamp < viewer.base) continue;
			viewer.audioTime = Math.max(viewer.audioTime, timestamp - viewer.base);
			this.write(viewer, flvTag(8, viewer.audioTime, payload));
		}
	}
}
