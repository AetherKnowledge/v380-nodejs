import { Socket } from 'net';

// A single consumer reads headers and payloads in order, without timer polling.
export function readCameraBytes(socket: Socket, size: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (!Number.isInteger(size) || size <= 0 || size > 1024 * 1024 * 1024) {
			reject(new Error('Invalid camera packet read size'));
			return;
		}
		const cleanup = () => {
			socket.removeListener('readable', read);
			socket.removeListener('end', closed);
			socket.removeListener('close', closed);
			socket.removeListener('error', failed);
		};
		const failed = (error: Error) => {
			cleanup();
			reject(error);
		};
		const closed = () => failed(new Error('Camera closed connection during a packet'));
		const read = () => {
			let data: Buffer | null;
			try {
				data = socket.read(size);
			} catch (err) {
				failed(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			if (data !== null) {
				cleanup();
				if (data.length !== size) {
					reject(new Error('Camera closed connection during a packet'));
				} else {
					resolve(data);
				}
			} else if (socket.destroyed || socket.readableEnded) {
				closed();
			}
		};
		socket.on('readable', read);
		socket.once('end', closed);
		socket.once('close', closed);
		socket.once('error', failed);
		read();
	});
}
