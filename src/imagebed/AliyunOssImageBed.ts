/**
 * 阿里云 OSS 图床实现
 * 使用 OSS V1 预签名 URL 方式，前端直接调用 REST API
 */

import { ImageBed, CloudFile, UploadResult, ImageLMgrSettings } from "../types";

/** 直接 HTTP 请求（绕过 Obsidian 代理，避免额外头部破坏签名） */
async function directFetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer } = {}): Promise<{ ok: boolean; status: number; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }> {
	if (typeof window !== "undefined" && "require" in window) {
		const https = (window as any).require("https");
		const { URL } = (window as any).require("url");
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			const reqOpts = {
				hostname: parsed.hostname,
				port: parsed.port || 443,
				path: parsed.pathname + parsed.search,
				method: options.method || "GET",
				headers: options.headers || {},
			};
			const req = https.request(reqOpts, (res: any) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const buf = Buffer.concat(chunks);
					resolve({
						ok: res.statusCode >= 200 && res.statusCode < 300,
						status: res.statusCode,
						text: async () => buf.toString("utf-8"),
						arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
					});
				});
			});
			req.on("error", reject);
			if (options.body) {
				const bodyData = typeof options.body === "string" ? options.body : Buffer.from(options.body);
				req.write(bodyData);
			}
			req.end();
		});
	}
	return fetch(url, options as any);
}

export class AliyunOssImageBed implements ImageBed {
	private endpoint = "";
	private bucket = "";
	private accessKeyId = "";
	private accessKeySecret = "";

	configure(settings: ImageLMgrSettings) {
		this.endpoint = (settings.aliyunEndpoint || "").trim().replace(/\/+$/, "");
		this.bucket = (settings.aliyunBucket || "").trim();
		this.accessKeyId = (settings.aliyunAccessKeyId || "").trim();
		let rawSecret = settings.aliyunAccessKeySecret || "";
		rawSecret = rawSecret.trim().replace(/[​‌‍﻿ ]/g, "");
		this.accessKeySecret = rawSecret;
	}

	private getBaseUrl(): string {
		const ep = this.endpoint.replace(/^https?:\/\//, "");
		return `https://${this.bucket}.${ep}`;
	}

	/** SHA-256 哈希（返回 hex 字符串） */
	private async sha256(data: Uint8Array): Promise<string> {
		if (typeof window !== "undefined" && "require" in window) {
			const nodeCrypto = (window as any).require("crypto");
			return nodeCrypto.createHash("sha256").update(Buffer.from(data)).digest("hex");
		}
		const hashBuf = await crypto.subtle.digest("SHA-256", data as any);
		return Array.from(new Uint8Array(hashBuf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/** 从 endpoint 提取区域，如 oss-cn-chengdu.aliyuncs.com → cn-chengdu */
	private getRegion(): string {
		const match = this.endpoint.match(/oss-([^.]+)\./);
		return match ? match[1] : "oss-cn-hangzhou";
	}

	/**
	 * 生成 OSS V4 预签名 URL（OSS4-HMAC-SHA256）
	 *
	 * @param method HTTP 方法
	 * @param objectPath object 路径，如 /images/a.jpg
	 * @param expiresSeconds 过期秒数（相对时间）
	 * @param subResources 子资源参数
	 */
	async signUrl(
		method: string,
		objectPath: string,
		expiresSeconds: number,
		subResources?: Record<string, string>
	): Promise<string> {
		const now = new Date();
		const dateStr = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
		const date8 = dateStr.slice(0, 8);
		const region = this.getRegion();

		// ===== 1. 构造规范查询串 =====
		const params = new URLSearchParams();
		params.set("x-oss-expires", String(expiresSeconds));
		params.set("x-oss-date", dateStr);
		params.set("x-oss-signature-version", "OSS4-HMAC-SHA256");
		params.set(
			"x-oss-credential",
			`${this.accessKeyId}/${date8}/${region}/oss/aliyun_v4_request`
		);

		if (subResources) {
			for (const [k, v] of Object.entries(subResources)) {
				params.set(k, v);
			}
		}
		params.sort();

		const canonicalQueryString = params.toString();

		// ===== 2. 构造规范请求 =====
		// OSS V4 canonical URI 需要包含 bucket 前缀，如 /obsidian-imgs/
		// 路径段需要 percent-encode（保留 /）
		const encodedObjectPath = objectPath.split("/").map(encodeURIComponent).join("/");
		const canonicalUri = `/${this.bucket}${encodedObjectPath}`;
		const canonicalHeaders = "";
		const signedHeaders = "";
		const canonicalRequest = [
			method,
			canonicalUri,
			canonicalQueryString,
			canonicalHeaders,
			signedHeaders,
			"UNSIGNED-PAYLOAD",
		].join("\n");

		// ===== 3. 构造待签名字符串 =====
		const credentialScope = `${date8}/${region}/oss/aliyun_v4_request`;
		const hashedCanonicalReq = await this.sha256(new TextEncoder().encode(canonicalRequest));
		const stringToSign = [
			"OSS4-HMAC-SHA256",
			dateStr,
			credentialScope,
			hashedCanonicalReq,
		].join("\n");

		// ===== 4. 推导签名密钥 =====
		const nodeCrypto = typeof window !== "undefined" && "require" in window
			? (window as any).require("crypto")
			: null;

		let signature: string;

		if (nodeCrypto) {
			// Node.js crypto 路径
			let kDate = nodeCrypto.createHmac("sha256", "aliyun_v4" + this.accessKeySecret)
				.update(date8).digest();
			let kRegion = nodeCrypto.createHmac("sha256", kDate)
				.update(region).digest();
			let kService = nodeCrypto.createHmac("sha256", kRegion)
				.update("oss").digest();
			let kSigning = nodeCrypto.createHmac("sha256", kService)
				.update("aliyun_v4_request").digest();
			signature = nodeCrypto.createHmac("sha256", kSigning)
				.update(stringToSign).digest("hex");
		} else {
			// Web Crypto API 路径
			const enc = new TextEncoder();
			const hmac = async (key: Uint8Array | ArrayBuffer, msg: string): Promise<ArrayBuffer> => {
				const k = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
				return crypto.subtle.sign("HMAC", k, enc.encode(msg));
			};
			let kDate = await hmac(enc.encode("aliyun_v4" + this.accessKeySecret), date8);
			let kRegion = await hmac(new Uint8Array(kDate), region);
			let kService = await hmac(new Uint8Array(kRegion), "oss");
			let kSigning = await hmac(new Uint8Array(kService), "aliyun_v4_request");
			const sigBuf = await hmac(new Uint8Array(kSigning), stringToSign);
			signature = Array.from(new Uint8Array(sigBuf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}

		// ===== 5. 组装 URL =====
		params.set("x-oss-signature", signature);
		return `${this.getBaseUrl()}${encodedObjectPath}?${params.toString()}`;
	}

	async listFiles(): Promise<CloudFile[]> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return [];
		}

		const files: CloudFile[] = [];
		let continuationToken = "";

		try {
			do {
				const expires = 3600;
				const resource = "/";

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

				const response = await directFetch(url);
				if (!response.ok) {
					console.error("OSS ListObjects failed:", response.status);
					break;
				}

				const xmlText = await response.text();
				const parser = new DOMParser();
				const xmlDoc = parser.parseFromString(xmlText, "application/xml");

				// 检查错误
				const errorCode = xmlDoc.querySelector("Code");
				if (errorCode) {
					console.error("OSS API Error:", errorCode.textContent, xmlDoc.querySelector("Message")?.textContent);
					break;
				}

				const baseUrl = this.getBaseUrl();

				// 解析文件（Contents）
				const contents = Array.from(xmlDoc.querySelectorAll("Contents"));
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
			console.error("OSS listFiles error:", e instanceof Error ? e.message : String(e));
		}

		return files;
	}

	async upload(file: File, imagePath?: string): Promise<UploadResult> {
		if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
			return { success: false, error: "阿里云 OSS 配置不完整" };
		}

		try {
			const expires = 3600;
			// 使用 frontmatter imagePath 或默认 images/ 目录
			const prefix = imagePath ? imagePath.replace(/^\/+|\/+$/g, "") : "images";
			const objectKey = `${prefix}/${file.name}`;
			const resource = `/${objectKey}`;

			const url = await this.signUrl("PUT", resource, expires);

			const arrayBuffer = await file.arrayBuffer();
			const response = await directFetch(url, {
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
			const expires = 3600;
			const objectKey = filename.includes("/") ? filename : `images/${filename}`;
			const resource = `/${objectKey}`;

			const url = await this.signUrl("DELETE", resource, expires);

			const response = await directFetch(url, { method: "DELETE" });

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
			const expires = 60;
			const resource = "/";
			const subResources: Record<string, string> = { "list-type": "2", "max-keys": "1" };

			const url = await this.signUrl("GET", resource, expires, subResources);
			const response = await directFetch(url);

			if (response.ok || response.status === 404) {
				return { success: true };
			}

			// 解析 OSS 错误 XML 获取详细原因
			const errText = await response.text();
			let detail = errText.slice(0, 500);
			try {
				const parser = new DOMParser();
				const xmlDoc = parser.parseFromString(errText, "application/xml");
				const code = xmlDoc.querySelector("Code")?.textContent;
				const msg = xmlDoc.querySelector("Message")?.textContent;
				const reqId = xmlDoc.querySelector("RequestId")?.textContent;
				if (code) detail = `${code}: ${msg} (RequestId: ${reqId})`;
			} catch { /* 保持原文 */ }
			return { success: false, error: `HTTP ${response.status} - ${detail}` };
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
			const expires = 3600;
			// 确保目录名以 / 结尾
			const dirKey = dirName.endsWith("/") ? dirName : `${dirName}/`;
			const resource = `/${dirKey}`;

			const url = await this.signUrl("PUT", resource, expires);

			const response = await directFetch(url, {
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

	async testCreateDirectoryCapability(): Promise<{ supported: boolean; reason?: string }> {
		return { supported: true };
	}
}
