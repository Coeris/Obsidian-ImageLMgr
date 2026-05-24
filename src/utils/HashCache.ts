/**
 * 图片上传去重缓存
 * 基于 SHA-256 文件哈希，避免重复上传相同图片
 */

export interface HashEntry {
	/** 文件 SHA-256 哈希值 */
	hash: string;
	/** 已上传后的云端 URL */
	url: string;
	/** 上传到的图床类型 */
	bedType: string;
	/** 上传时间戳 */
	uploadedAt: number;
	/** 原始文件名 */
	fileName: string;
}

const MAX_CACHE_SIZE = 2000;

export class HashCache {
	private cache: Map<string, HashEntry> = new Map();
	private dirty = false;

	constructor(serialized?: string) {
		if (serialized) {
			try {
				const data = JSON.parse(serialized);
				if (Array.isArray(data)) {
					for (const entry of data) {
						if (entry.hash && entry.url) {
							this.cache.set(entry.hash, entry);
						}
					}
				}
			} catch {
				// 数据损坏，忽略
			}
		}
	}

	/**
	 * 计算文件的 SHA-256 哈希
	 */
	static async computeHash(file: File): Promise<string> {
		const buffer = await file.arrayBuffer();
		const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	/**
	 * 查询是否已上传过相同内容的图片
	 */
	get(hash: string): HashEntry | undefined {
		return this.cache.get(hash);
	}

	/**
	 * 记录一次成功上传
	 */
	set(hash: string, entry: HashEntry): void {
		// LRU: 超过容量时删除最旧条目
		if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(hash)) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey) this.cache.delete(oldestKey);
		}
		this.cache.set(hash, { ...entry, uploadedAt: Date.now() });
		this.dirty = true;
	}

	/**
	 * 序列化用于持久化存储
	 */
	serialize(): string {
		return JSON.stringify(Array.from(this.cache.values()));
	}

	/**
	 * 是否有未保存的更改
	 */
	isDirty(): boolean {
		return this.dirty;
	}

	/**
	 * 标记为已保存
	 */
	markClean(): void {
		this.dirty = false;
	}

	/** 缓存中的条目数量 */
	get size(): number {
		return this.cache.size;
	}
}
