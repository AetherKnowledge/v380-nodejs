// typebase 1.0.1 publishes legacy .ts source without declaration files.
// Describe the API used here while the runtime continues loading typebase.js.
declare module 'typebase' {
	export class Pointer {
		constructor(buf: Buffer, offset?: number);
		buf: Buffer;
		off: number;
		clone(): Pointer;
	}

	export interface IType {
		size: number;
		name: string;
		pack(pointer: Pointer, data: any): void;
		unpack(pointer: Pointer, length?: number): any;
	}

	export interface List extends IType {
		type: IType;
		length: number;
	}
	export const List: {
		define(type: IType, length?: number): List;
	};

	export type Struct = IType;
	export const Struct: {
		define(fields: ([string, IType] | Struct)[], name?: string): Struct;
	};

	export const i32: IType;
	export const ui8: IType;
	export const ui16: IType;
	export const ui32: IType;
}
