const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
	34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
	157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
	598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
	1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
	5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
	13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

// Mono IMA WAV: one predictor sample and 504 nibbles per 256-byte block.
export class ImaEncoder {
	private index = 0;
	encode(pcm: Buffer): Buffer {
		if (!pcm.length || pcm.length > 1010 || pcm.length % 2) throw new Error('Expected 1 to 505 signed 16-bit PCM samples');
		const samples = Buffer.alloc(1010);
		pcm.copy(samples);
		const block = Buffer.alloc(256);
		let predictor = samples.readInt16LE(0);
		block.writeInt16LE(predictor, 0);
		block[2] = this.index;
		for (let i = 1; i < 505; i++) {
			let difference = samples.readInt16LE(i * 2) - predictor;
			let nibble = difference < 0 ? 8 : 0;
			difference = Math.abs(difference);
			let step = STEP[this.index];
			let delta = step >> 3;
			for (const bit of [4, 2, 1]) {
				if (difference >= step) { nibble |= bit; difference -= step; delta += step; }
				step >>= 1;
			}
			predictor = Math.max(-32768, Math.min(32767, predictor + (nibble & 8 ? -delta : delta)));
			this.index = Math.max(0, Math.min(88, this.index + INDEX[nibble & 7]));
			block[4 + ((i - 1) >> 1)] |= nibble << ((i - 1) % 2 * 4);
		}
		return block;
	}
}

// Decode the camera's mono IMA WAV blocks without changing their sample rate.
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
