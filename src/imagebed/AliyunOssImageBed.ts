/**
 * 阿里云 OSS 图床实现
 * 使用 OSS V1 URL 签名方式，前端直接调用 REST API
 */

import { Notice } from "obsidian";
import { ImageBed, CloudFile, UploadResult, ImageLMgrSettings } from "../types";

export class AliyunOssImageBed implements ImageBed {
	private endpoint = "";
	private bucket = "";
	private accessKeyId = "";
	private accessKeySecret = "";

	configure(settings: ImageLMgrSettings) {
		this.endpoint = settings.aliyunEndpoint;
		this.bucket = settings.aliyunBucket;
		this.accessKeyId = settings.aliyunAccessKeyId;
		this.accessKeySecret = settings.aliyunAccessKeySecret;
	}

	private getBaseUrl(): string {
		// 确保 endpoint 不带协议前缀
		const ep = this.endpoint.replace(/^https?:\/\//, "");
		return `https://${this.bucket}.${ep}`;
	}

	/**
	 * 生成 OSS V1 URL 签名
	 * @param method HTTP 方法
	 * @param resource CanonicalizedResource，如 /{bucket}/ 或 /{bucket}/{objectKey}
	 * @param expires 过期时间戳（秒）
	 * @param headers 以 x-oss- 开头的自定义头（可选）
	 * @param subResources 子资源参数（可选，如 { prefix: '', 'max-keys': '1000', delimiter: '/' }）
	 */
	private async signUrl(
		method: string,
		resource: string,
		expires: number,
		subResources?: Record<string, string>
	): Promise<string> {
		// 构造子资源字符串（按字典序排列，参与签名）
		let subResourceStr = "";
		if (subResources) {
			const keys = Object.keys(subResources).sort();
			for (const key of keys) {
				const val = subResources[key];
				subResourceStr += subResourceStr ? `&${key}=${val}` : `${key}=${val}`;
			}
		}

		// CanonicalizedResource = resource + ? + subResources
		const canonicalizedResource = subResourceStr
			? `${resource}?${subResourceStr}`
			: resource;

		// StringToSign = VERB + \n + Content-MD5 + \n + Content-Type + \n + Expires + \n + CanonicalizedResource
		const stringToSign = `${method}\n\n\n${expires}\n${canonicalizedResource}`;

		// HMAC-SHA1 签名
		const encoder = new TextEncoder();
		const keyData = encoder.encode(this.accessKeySecret);
		const data = encoder.encode(stringToSign);

		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			keyData,
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"]
		);

		const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, data);
		const signatureArray = new Uint8Array(signatureBuffer);
		let binary = "";
		for (let i = 0; i < signatureArray.length; i++) {
			binary += String.fromCharCode(signatureArray[i]);
		}
		const signature = btoa(binary);

		// 构造完整 URL
		const baseUrl = this.getBaseUrl();
		const objectPath = resource.startsWith(`/${this.bucket}`)
			? resource.substring(`/${this.bucket}`.length)
			: resource;

		const params = new URLSearchParams();
		params.set("OSSAccessKeyId", this.accessKeyId);
		params.set("Expires", String(expires));
		params.set("Signature", signature);

		if (subResources) {
			for (const [k, v] of Object.entries(subResources)) {
				params.set(k, v);
			}
		}

		const urlPath = objectPath || "/";
		const separator = objectPath.includes("?") ? "&" : "?";
		return `${baseUrl}${urlPath}?${params.toString()}`;
	}

	async listFiles(): Promise<CloudFile[]> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return [];
		}

		const files: CloudFile[] = [];
		let continuationToken = "";

		try {
			do {
				const expires = Math.floor(Date.now() / 1000) + 3600;
				const resource = `/${this.bucket}/`;

				// 不使用 delimiter，递归列出所有文件
				const subResources: Record<string, string> = {
					"list-type": "2",
					"max-keys": "1000",
					"encoding-type": "url",
				};

				if (continuationToken) {
					subResources["continuation-token"] = continuationToken;
				}

				const url = await this.signUrl("GET", resource, expires, subResources);

				const response = await fetch(url);
				if (!response.ok) {
					const errText = await response.text();
					new Notice(`OSS 列表获取失败: HTTP ${response.status}`);
					console.error("OSS ListObjects failed:", response.status, errText);
					break;
				}

				const xmlText = await response.text();
				const parser = new DOMParser();
				const xmlDoc = parser.parseFromString(xmlText, "application/xml");

				// 检查错误
				const errorCode = xmlDoc.querySelector("Code");
				if (errorCode) {
					const errorMessage = xmlDoc.querySelector("Message")?.textContent || "";
					new Notice(`OSS 错误: ${errorCode.textContent} - ${errorMessage}`);
					console.error("OSS API Error:", errorCode.textContent, errorMessage);
					break;
				}

				const baseUrl = this.getBaseUrl();

				// 解析文件（Contents）
				const contents = xmlDoc.querySelectorAll("Contents");
				for (const content of contents) {
					const key = decodeURIComponent(
						content.querySelector("Key")?.textContent || ""
					);
					if (!key) continue;

					// 跳过以 / 结尾的目录占位对象
					if (key.endsWith("/")) continue;

					const name = key.split("/").pop() || key;
					const url = `${baseUrl}/${key}`;

					files.push({
						name,
						url,
						isDirectory: false,
						prefix: key,
					});
				}

				// 检查是否还有下一页
				const nextToken = xmlDoc.querySelector("NextContinuationToken")?.textContent || "";
				const isTruncated = xmlDoc.querySelector("IsTruncated")?.textContent === "true";
				continuationToken = isTruncated ? nextToken : "";

			} while (continuationToken);

			// 从文件路径中提取目录结构
			const dirSet = new Set<string>();
			for (const file of files) {
				const key = file.prefix || "";
				const parts = key.split("/");
				// 从路径中提取每层目录
				for (let i = 1; i < parts.length; i++) {
					const dirPath = parts.slice(0, i).join("/") + "/";
					if (!dirSet.has(dirPath)) {
						dirSet.add(dirPath);
						const baseUrl = this.getBaseUrl();
						files.push({
							name: parts[i - 1] + "/",
							url: `${baseUrl}/${dirPath}`,
							isDirectory: true,
							prefix: dirPath,
						});
					}
				}
			}

		} catch (e) {
			console.error("OSS listFiles error:", e);
		}

		return files;
	}

	async upload(file: File): Promise<UploadResult> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return { success: false, error: "阿里云 OSS 配置不完整" };
		}

		try {
			const expires = Math.floor(Date.now() / 1000) + 3600;
			// 上传到 images/ 目录下
			const objectKey = `images/${file.name}`;
			const resource = `/${this.bucket}/${objectKey}`;

			const url = await this.signUrl("PUT", resource, expires);

			const arrayBuffer = await file.arrayBuffer();
			const response = await fetch(url, {
				method: "PUT",
				body: arrayBuffer,
				headers: {
					"Content-Type": file.type || "application/octet-stream",
				},
			});

			if (!response.ok) {
				return { success: false, error: `上传失败: HTTP ${response.status}` };
			}

			const finalUrl = `${this.getBaseUrl()}/${objectKey}`;
			return { success: true, url: finalUrl };
		} catch (e) {
			return { success: false, error: `上传异常: ${e}` };
		}
	}

	/**
	 * 删除文件
	 */
	async delete(filename: string): Promise<{ success: boolean; error?: string }> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return { success: false, error: "阿里云 OSS 配置不完整" };
		}

		try {
			const expires = Math.floor(Date.now() / 1000) + 3600;
			const objectKey = filename.includes("/") ? filename : `images/${filename}`;
			const resource = `/${this.bucket}/${objectKey}`;

			const url = await this.signUrl("DELETE", resource, expires);

			const response = await fetch(url, { method: "DELETE" });

			if (!response.ok && response.status !== 204) {
				return { success: false, error: `删除失败: HTTP ${response.status}` };
			}

			return { success: true };
		} catch (e) {
			return { success: false, error: `删除异常: ${e}` };
		}
	}

	/**
	 * 测试连接：尝试列出文件（限制 1 条）
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return { success: false, error: "配置不完整" };
		}

		try {
			const expires = Math.floor(Date.now() / 1000) + 60;
			const resource = `/${this.bucket}/`;
			const subResources: Record<string, string> = { "list-type": "2", "max-keys": "1" };

			const url = await this.signUrl("GET", resource, expires, subResources);
			const response = await fetch(url);

			if (response.ok || response.status === 404) {
				// 404 也算连接成功，只是 bucket 为空
				return { success: true };
			}
			const errText = await response.text();
			return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 100)}` };
		} catch (e) {
			return { success: false, error: `连接异常: ${e}` };
		}
	}

	/**
	 * 创建目录（在 OSS 中 PUT 一个以 / 结尾的空对象）
	 */
	async createDirectory(dirName: string): Promise<{ success: boolean; error?: string }> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return { success: false, error: "阿里云 OSS 配置不完整" };
		}

		try {
			const expires = Math.floor(Date.now() / 1000) + 3600;
			// 确保目录名以 / 结尾
			const dirKey = dirName.endsWith("/") ? dirName : `${dirName}/`;
			const resource = `/${this.bucket}/${dirKey}`;

			const url = await this.signUrl("PUT", resource, expires);

			const response = await fetch(url, {
				method: "PUT",
				body: "",
				headers: {
					"Content-Type": "",
					"Content-Length": "0",
				},
			});

			if (!response.ok && response.status !== 200) {
				return { success: false, error: `创建目录失败: HTTP ${response.status}` };
			}

			return { success: true };
		} catch (e) {
			return { success: false, error: `创建目录异常: ${e}` };
		}
	}
}
