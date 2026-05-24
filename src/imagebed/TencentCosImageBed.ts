/**
 * 腾讯云 COS 图床实现
 * 使用 COS V5 签名方式，前端直接调用 REST API
 */

import { ImageBed, CloudFile, UploadResult, ImageLMgrSettings } from "../types";

export class TencentCosImageBed implements ImageBed {
	private secretId = "";
	private secretKey = "";
	private bucket = "";
	private region = "";

	configure(settings: ImageLMgrSettings) {
		this.secretId = (settings.tencentSecretId || "").trim();
		this.secretKey = (settings.tencentSecretKey || "").trim();
		this.bucket = (settings.tencentBucket || "").trim();
		this.region = (settings.tencentRegion || "").trim();
	}

	private getBaseUrl(): string {
		return `https://${this.bucket}.cos.${this.region}.myqcloud.com`;
	}

	/**
	 * 生成 COS Authorization 签名头（V5 签名）
	 * 参考: https://cloud.tencent.com/document/product/436/7778
	 */
	private async signRequest(
		method: string,
		path: string,
		headers?: Record<string, string>,
		queryParams?: Record<string, string>
	): Promise<{ url: string; authHeader: string }> {
		const now = new Date();
		const timestamp = Math.floor(now.getTime() / 1000);
		const date = now.toISOString().slice(0, 10).replace(/-/g, "");

		// Host 头
		const host = `${this.bucket}.cos.${this.region}.myqcloud.com`;

		// 合并 headers
		const allHeaders: Record<string, string> = { host, ...headers };

		// 1. CanonicalRequest
		const sortedHeaderKeys = Object.keys(allHeaders).map(k => k.toLowerCase()).sort();
		const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${allHeaders[k]}`).join("\n") + "\n";
		const signedHeaders = sortedHeaderKeys.join(";");

		let canonicalQuery = "";
		if (queryParams) {
			const sortedKeys = Object.keys(queryParams).sort();
			canonicalQuery = sortedKeys.map(k => `${k}=${encodeURIComponent(queryParams[k])}`).join("&");
		}

		// 对于 PUT 上传，使用 payload hash
		const payloadHash = "UNSIGNED-PAYLOAD";

		const canonicalRequest = [
			method,
			path,
			canonicalQuery,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");

		// 2. StringToSign
		const algorithm = "sha256";
		const scope = `${date}/${this.region}/cos/tc3_request`;

			const cryptoSubtle = crypto.subtle;
		const encoder = new TextEncoder();

			const canonicalReqHashBuff = await cryptoSubtle.digest("SHA-256", encoder.encode(canonicalRequest));
		const canonicalReqHex = Array.from(new Uint8Array(canonicalReqHashBuff))
			.map(b => b.toString(16).padStart(2, "0")).join("");

		const stringToSign = [
			"q-sign-algorithm=sha1&q-ak=" + this.secretId +
			"&q-sign-time=" + `${timestamp};${timestamp + 3600}` +
			"&q-key-time=" + `${timestamp};${timestamp + 3600}` +
			"&q-header-list=" + sortedHeaderKeys.join(";") +
			"&q-url-param-list=" + (queryParams ? Object.keys(queryParams).sort().join(";") : "") +
			"&q-signature=" + canonicalReqHex,
		].join("\n");

		// 3. Signature (HMAC-SHA1)
		const keyData = encoder.encode(this.secretKey);
		const data = encoder.encode(stringToSign);

		const cryptoKey = await cryptoSubtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
		const sigBuffer = await cryptoSubtle.sign("HMAC", cryptoKey, data);
		const sigArray = new Uint8Array(sigBuffer);
		let binary = "";
		for (let i = 0; i < sigArray.length; i++) {
			binary += String.fromCharCode(sigArray[i]);
		}
		const signature = btoa(binary);

		const authorization =
			`q-sign-algorithm=sha1&q-ak=${this.secretId}` +
			`&q-sign-time=${timestamp};${timestamp + 3600}` +
			`&q-key-time=${timestamp};${timestamp + 3600}` +
			`&q-header-list=${sortedHeaderKeys.join(";")}` +
			`&q-url-param-list=${queryParams ? Object.keys(queryParams).sort().join(";") : ""}` +
			`&q-signature=${signature}`;

		// 构造完整 URL
		let url = `https://${host}${path}`;
		if (canonicalQuery) {
			url += "?" + canonicalQuery;
		}

		return { url, authHeader: authorization };
	}

	async listFiles(): Promise<CloudFile[]> {
		if (!this.secretId || !this.secretKey || !this.bucket || !this.region) {
			return [];
		}

		const files: CloudFile[] = [];

		try {
			const baseUrl = this.getBaseUrl();
			let marker = "";

			do {
			const queryParams: Record<string, string> = {
				"max-keys": "1000",
				"prefix": "",
				"encoding-type": "url",
			};
			if (marker) {
				queryParams["marker"] = marker;
			}

				const { url, authHeader } = await this.signRequest("GET", "/", {}, queryParams);

				const response = await fetch(url, {
					headers: { Authorization: authHeader },
				});

				if (!response.ok) {
					console.error("COS ListObjects failed:", response.status);
					break;
				}

				const xmlText = await response.text();
				const parser = new DOMParser();
				const xmlDoc = parser.parseFromString(xmlText, "application/xml");

				// 检查错误
				const errorCode = xmlDoc.querySelector("Code");
				if (errorCode) {
					const errorMessage = xmlDoc.querySelector("Message")?.textContent || "";
					console.error("COS API Error:", errorCode.textContent, errorMessage);
					break;
				}

				// 解析文件（Contents）
				const contents = Array.from(xmlDoc.querySelectorAll("Contents"));
				for (const content of contents) {
					const key = decodeURIComponent(
						content.querySelector("Key")?.textContent || ""
					);
					if (!key) continue;
					if (key.endsWith("/")) continue;

					const name = key.split("/").pop() || key;
					files.push({
						name,
						url: `${baseUrl}/${key}`,
						isDirectory: false,
						prefix: key,
					});
				}

				marker = decodeURIComponent(xmlDoc.querySelector("IsTruncated")?.textContent === "true"
					? (xmlDoc.querySelector("NextMarker")?.textContent || "")
					: "");
			} while (marker);

			// 从文件路径中提取目录结构
			const dirSet = new Set<string>();
			for (const file of files) {
				const parts = (file.prefix || "").split("/");
				for (let i = 1; i < parts.length; i++) {
					const dirPath = parts.slice(0, i).join("/") + "/";
					if (!dirSet.has(dirPath)) {
						dirSet.add(dirPath);
						files.push({
							name: parts[i - 1] + "/",
							url: `${this.getBaseUrl()}/${dirPath}`,
							isDirectory: true,
							prefix: dirPath,
						});
					}
				}
			}
		} catch (e) {
			console.error("COS listFiles error:", e instanceof Error ? e.message : String(e));
		}

		return files;
	}

	async upload(file: File, imagePath?: string): Promise<UploadResult> {
		if (!this.secretId || !this.secretKey || !this.bucket || !this.region) {
			return { success: false, error: "腾讯云 COS 配置不完整" };
		}

		try {
			const prefix = imagePath ? imagePath.replace(/^\/+|\/+$/g, "") : "images";
			const objectKey = `${prefix}/${file.name}`;
			const { url, authHeader } = await this.signRequest("PUT", `/${objectKey}`, {
				"Content-Type": file.type || "application/octet-stream",
			});

			const arrayBuffer = await file.arrayBuffer();
			const response = await fetch(url, {
				method: "PUT",
				body: arrayBuffer,
				headers: {
					Authorization: authHeader,
					"Content-Type": file.type || "application/octet-stream",
				},
			});

			if (!response.ok) {
				return { success: false, error: `上传失败: HTTP ${response.status}` };
			}

			return { success: true, url: `${this.getBaseUrl()}/${objectKey}` };
		} catch (e) {
			return { success: false, error: `上传异常: ${e}` };
		}
	}

	async delete(filename: string): Promise<{ success: boolean; error?: string }> {
		if (!this.secretId || !this.secretKey || !this.bucket || !this.region) {
			return { success: false, error: "腾讯云 COS 配置不完整" };
		}

		try {
			const objectKey = filename.includes("/") ? filename : `images/${filename}`;
			const { url, authHeader } = await this.signRequest("DELETE", `/${objectKey}`);

			const response = await fetch(url, {
				method: "DELETE",
				headers: { Authorization: authHeader },
			});

			if (!response.ok && response.status !== 204) {
				return { success: false, error: `删除失败: HTTP ${response.status}` };
			}

			return { success: true };
		} catch (e) {
			return { success: false, error: `删除异常: ${e}` };
		}
	}

	/**
	 * 测试连接：尝试 ListObjects（限制 1 条）
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.secretId || !this.secretKey || !this.bucket || !this.region) {
			return { success: false, error: "配置不完整" };
		}

		try {
			const queryParams: Record<string, string> = {
				"max-keys": "1",
				"prefix": "",
			};
			const { url, authHeader } = await this.signRequest("GET", "/", {}, queryParams);

			const response = await fetch(url, { headers: { Authorization: authHeader } });

			if (response.ok || response.status === 404 || response.status === 403) {
				return { success: true };
			}
			const errText = await response.text();
			return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 100)}` };
		} catch (e) {
			return { success: false, error: `连接异常: ${e}` };
		}
	}

	async createDirectory(dirName: string): Promise<{ success: boolean; error?: string }> {
		if (!this.secretId || !this.secretKey || !this.bucket || !this.region) {
			return { success: false, error: "腾讯云 COS 配置不完整" };
		}

		try {
			const dirKey = dirName.endsWith("/") ? dirName : `${dirName}/`;
			const { url, authHeader } = await this.signRequest("PUT", `/${dirKey}`);

			const response = await fetch(url, {
				method: "PUT",
				body: "",
				headers: {
					Authorization: authHeader,
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
