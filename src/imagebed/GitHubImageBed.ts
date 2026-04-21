/**
 * GitHub 图床实现
 */

import { ImageBed, CloudFile, UploadResult, ImageLMgrSettings } from "../types";

export class GitHubImageBed implements ImageBed {
	private token = "";
	private owner = "";
	private repo = "";
	private branch = "main";
	private path = "";

	configure(settings: ImageLMgrSettings) {
		this.token = settings.githubToken;
		this.owner = settings.githubOwner;
		this.repo = settings.githubRepo;
		this.branch = settings.githubBranch || "main";
		this.path = settings.githubPath || "images";
	}

	async listFiles(): Promise<CloudFile[]> {
		if (!this.token || !this.owner || !this.repo) return [];

		const files: CloudFile[] = [];
		let page = 1;
		const perPage = 100;
		const basePath = this.path ? `${this.path}/` : "";

		// 获取指定目录下的文件列表
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}?ref=${this.branch}&per_page=${perPage}`;

		try {
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/vnd.github.v3+json",
				},
			});

			if (!response.ok) return [];

			const data = await response.json();
			if (!Array.isArray(data)) return [];

			for (const item of data) {
				if (item.type === "file") {
					const name = item.name;
					const downloadUrl = item.download_url || `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${basePath}${name}`;
					files.push({ name, url: downloadUrl });
				}
			}
		} catch {
			// 网络错误静默处理
		}

		return files;
	}

	async upload(file: File): Promise<UploadResult> {
		if (!this.token || !this.owner || !this.repo) {
			return { success: false, error: "GitHub 图床配置不完整" };
		}

		const basePath = this.path ? `${this.path}/` : "";
		const path = `${basePath}${file.name}`;
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;

		try {
			const arrayBuffer = await file.arrayBuffer();
			const base64 = arrayBufferToBase64(arrayBuffer);

			const response = await fetch(url, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					Accept: "application/vnd.github.v3+json",
				},
				body: JSON.stringify({
					message: `Upload ${file.name} via ImageLMgr`,
					content: base64,
					branch: this.branch,
				}),
			});

			if (!response.ok) {
				const err = await response.json();
				return { success: false, error: err.message || "上传失败" };
			}

			const result = await response.json();
			const downloadUrl = result.content?.download_url || `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;

			return { success: true, url: downloadUrl };
		} catch (e) {
			return { success: false, error: `上传异常: ${e}` };
		}
	}

	async delete(filename: string): Promise<{ success: boolean; error?: string }> {
		if (!this.token || !this.owner || !this.repo) {
			return { success: false, error: "GitHub 图床配置不完整" };
		}

		const basePath = this.path ? `${this.path}/` : "";
		const path = `${basePath}${filename}`;
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;

		try {
			// 先获取文件 SHA
			const getResponse = await fetch(`${url}?ref=${this.branch}`, {
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/vnd.github.v3+json",
				},
			});

			if (!getResponse.ok) {
				return { success: false, error: "文件不存在" };
			}

			const data = await getResponse.json();
			const sha = data.sha;

			const deleteResponse = await fetch(url, {
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					Accept: "application/vnd.github.v3+json",
				},
				body: JSON.stringify({
					message: `Delete ${filename} via ImageLMgr`,
					sha,
					branch: this.branch,
				}),
			});

			if (!deleteResponse.ok) {
				const err = await deleteResponse.json();
				return { success: false, error: err.message || "删除失败" };
			}

			return { success: true };
		} catch (e) {
			return { success: false, error: `删除异常: ${e}` };
		}
	}

	/**
	 * 测试连接：尝试获取仓库信息
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.token || !this.owner || !this.repo) {
			return { success: false, error: "配置不完整" };
		}

		try {
			const response = await fetch(
				`https://api.github.com/repos/${this.owner}/${this.repo}`,
				{
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/vnd.github.v3+json",
					},
				}
			);

			if (response.ok) {
				return { success: true };
			}
			if (response.status === 401) return { success: false, error: "Token 无效或已过期" };
			if (response.status === 404) return { success: false, error: "仓库不存在" };
			if (response.status === 403) return { success: false, error: "Token 无该仓库权限（需要 repo 权限）" };

			const err = await response.json();
			return { success: false, error: err.message || `HTTP ${response.status}` };
		} catch (e) {
			return { success: false, error: `连接异常: ${e}` };
		}
	}

	async createDirectory(_dirName: string): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "GitHub 图床不支持创建目录" };
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
