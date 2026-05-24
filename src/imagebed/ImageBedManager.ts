/**
 * 模块4：图床管理器
 * 管理多个图床实例
 */

import { ImageBedType, ImageBed } from "../types";

export class ImageBedManager {
	private beds = new Map<ImageBedType, ImageBed>();

	register(type: ImageBedType, bed: ImageBed) {
		this.beds.set(type, bed);
	}

	get(type: ImageBedType): ImageBed | undefined {
		return this.beds.get(type);
	}

	getAll(): ImageBed[] {
		return Array.from(this.beds.values());
	}

	getTypes(): ImageBedType[] {
		return Array.from(this.beds.keys());
	}
}
