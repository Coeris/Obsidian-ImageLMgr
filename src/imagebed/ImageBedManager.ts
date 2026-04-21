/**
 * 模块4：图床管理器
 * 管理多个图床实例
 */

import { ImageBedType, CloudFile, UploadResult, ImageLMgrSettings, ImageBed } from "../types";

export interface ImageBed {
	/** 配置图床 */
	configure(settings: ImageLMgrSettings): void;
	/** 获取文件列表 */
	listFiles(): Promise<CloudFile[]>;
	/** 上传文件 */
	upload(file: File): Promise<UploadResult>;
	/** 删除文件 */
	delete(filename: string): Promise<{ success: boolean; error?: string }>;
	/** 创建目录 */
	createDirectory(dirName: string): Promise<{ success: boolean; error?: string }>;
	/**
	 * 测试连接
	 * @returns 连接成功返回 { success: true }，失败返回错误信息
	 */
	testConnection?(): Promise<{ success: boolean; error?: string }>;
}

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
