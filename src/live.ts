import { Writable } from 'stream';
import { performance } from 'perf_hooks';
import { setInterval, clearInterval } from 'timers';

import { decodeImaWave } from './ima';
export { decodeImaWave } from './ima';

// G.711 preserves 8 kHz mono audio without AAC buffering or a second process.
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

interface Viewer {
	output: Writable; base?: number; videoTime: number; audioTime: number; joinedAt: number; offset: number;
	audioNext?: number; audioDueAt?: number; audioOrigin?: number;
}
const MAX_BYTES = 8 * 1024 * 1024;
const AUDIO_GAP_MS = 200;
const SILENCE_SAMPLES = 505;
const SILENCE_MS = SILENCE_SAMPLES / 8;
const SILENCE = Buffer.concat([Buffer.from([0x82]), Buffer.alloc(SILENCE_SAMPLES, 0xff)]);

export class LiveFlv {
	constructor(private readonly audioOnly = false) {}

	private viewers = new Set<Viewer>();
	private config?: Buffer;
	private cache: Buffer[] = [];
	private cacheBytes = 0;
	private latest = 0;
	private silenceTimer?: ReturnType<typeof setInterval>;

	reset() {
		this.config = undefined;
		this.cache = [];
		this.cacheBytes = 0;
		this.latest = 0;
		for (const viewer of this.viewers) {
			// Independent audio consumers keep their clock and receive silence
			// across camera reauthentication; they never need a new video IDR.
			if (this.audioOnly) continue;
			viewer.base = undefined;
			viewer.offset = Math.max(viewer.videoTime, viewer.audioTime) + 1;
			viewer.audioNext = undefined;
			viewer.audioDueAt = undefined;
			viewer.audioOrigin = undefined;
		}
	}

	attach(output: Writable) {
		const viewer: Viewer = { output, videoTime: 0, audioTime: 0, joinedAt: Date.now(), offset: 0,
			audioDueAt: this.audioOnly ? performance.now() + AUDIO_GAP_MS : undefined };
		this.viewers.add(viewer);
		output.once('close', () => this.remove(viewer));
		this.write(viewer, Buffer.from(this.audioOnly ? '464c5601040000000900000000' : '464c5601050000000900000000', 'hex'));
		if (this.config && this.cache.length) {
			this.start(viewer, this.latest);
			this.write(viewer, flvTag(9, 0, this.config));
			// Prime decoder references at time zero, then start its live clock at
			// the newest frame. Replaying historical durations adds a whole GOP delay.
			for (const payload of this.cache) this.write(viewer, flvTag(9, 0, payload));
		}
		if (this.viewers.size && !this.silenceTimer) {
			this.silenceTimer = setInterval(() => this.fillAudioGaps(), 25);
			this.silenceTimer.unref();
		}
	}

	private start(viewer: Viewer, timestamp: number) {
		if (viewer.offset) viewer.offset = Math.max(viewer.offset, Date.now() - viewer.joinedAt);
		viewer.base = timestamp - viewer.offset;
		viewer.videoTime = viewer.offset;
		viewer.audioTime = viewer.offset;
		viewer.audioNext = viewer.offset;
		viewer.audioOrigin = performance.now() - viewer.offset;
		viewer.audioDueAt = performance.now() + AUDIO_GAP_MS;
		// Announce audio before a large IDR exhausts the player's probe budget.
		// One mu-law silence sample (0.125 ms) declares the codec without delay.
		if (!this.audioOnly) this.write(viewer, flvTag(8, viewer.offset, Buffer.from([0x82, 0xff])));
	}

	private write(viewer: Viewer, data: Buffer) {
		if (viewer.output.destroyed || viewer.output.writableLength + data.length > MAX_BYTES) {
			this.remove(viewer);
			viewer.output.destroy();
		} else viewer.output.write(data);
	}

	private remove(viewer: Viewer) {
		this.viewers.delete(viewer);
		if (!this.viewers.size && this.silenceTimer) {
			clearInterval(this.silenceTimer);
			this.silenceTimer = undefined;
		}
	}

	private writeAudio(viewer: Viewer, payload: Buffer, time: number) {
		viewer.audioTime = time;
		viewer.audioNext = time + (payload.length - 1) / 8;
		this.write(viewer, flvTag(8, time, payload));
	}

	private fillAudioGaps() {
		const now = performance.now();
		for (const viewer of this.viewers) {
			if (viewer.audioDueAt === undefined || now < viewer.audioDueAt) continue;
			if (this.audioOnly && viewer.base === undefined) {
				this.start(viewer, 0);
				viewer.audioDueAt = now;
			}
			if (viewer.base === undefined || viewer.audioNext === undefined) continue;
			// A stalled event loop must not enqueue seconds of catch-up audio.
			if (now - viewer.audioDueAt! > 4 * SILENCE_MS) {
				viewer.audioNext += now - viewer.audioDueAt!;
				viewer.audioDueAt = now;
			}
			for (let sent = 0; sent < 4 && this.viewers.has(viewer) && now >= viewer.audioDueAt!; sent++) {
				this.writeAudio(viewer, SILENCE, viewer.audioNext!);
				viewer.audioDueAt! += SILENCE_MS;
			}
		}
	}

	video(frame: Buffer, timestamp: number) {
		if (this.audioOnly) return;
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
		const now = performance.now();
		for (const viewer of this.viewers) {
			if (this.audioOnly && viewer.base === undefined) this.start(viewer, timestamp);
			if (viewer.base === undefined) continue;
			if (this.audioOnly) {
				// Pace timestamps by samples, independent of camera clock resets.
				// Bound latency if a recovering camera bursts buffered audio.
				if (viewer.audioNext! > now - viewer.audioOrigin! + 250) continue;
				this.writeAudio(viewer, payload, viewer.audioNext!);
			} else {
				if (timestamp < viewer.base) continue;
				const time = timestamp - viewer.base;
				const overlap = viewer.audioNext! - time;
				// Permit sub-millisecond timestamp rounding. Drop already-filled
				// samples if delayed audio arrives after silence was emitted.
				const skip = overlap > 1 ? Math.ceil(overlap * 8) : 0;
				if (skip >= payload.length - 1) continue;
				const fresh = skip ? Buffer.concat([payload.subarray(0, 1), payload.subarray(skip + 1)]) : payload;
				this.writeAudio(viewer, fresh, Math.max(time, viewer.audioNext!));
			}
			viewer.audioDueAt = now + (payload.length - 1) / 8 + AUDIO_GAP_MS;
		}
	}
}
