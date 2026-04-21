/**
 * SM.MS 图床实现
 */

import { ImageBed, CloudFile, UploadResult, ImageLMgrSettings } from "../types";

const SMMS_API = "https://smms.app/api/v2";

export class SmmsImageBed implements ImageBed {
	private token = "";

	configure(settings: ImageLMgrSettings) {
		this.token = settings.smmsToken;
	}

	async listFiles(): Promise<CloudFile[]> {
		if (!this.token) return [];

		try {
			const response = await fetch(`${SMMS_API}/upload_history`, {
				headers: {
					Authorization: this.token,
				},
			});

			if (!response.ok) return [];

			const data = await response.json();
			if (!data.success || !Array.isArray(data.data)) return [];

			return data.data.map((item: any) => ({
				name: item.filename || item.origin_name || "",
				url: item.url || "",
			}));
		} catch {
			return [];
		}
	}

	async upload(file: File): Promise<UploadResult> {
		if (!this.token) {
			return { success: false, error: "SM.MS Token 未配置" };
		}

		try {
			const formData = new FormData();
			formData.append("smfile", file);

			const response = await fetch(`${SMMS_API}/upload`, {
				method: "POST",
				headers: {
					Authorization: this.token,
				},
				body: formData,
			});

			const data = await response.json();

			if (!data.success) {
				return { success: false, error: data.message || "上传失败" };
			}

			return { success: true, url: data.data?.url };
		} catch (e) {
			return { success: false, error: `上传异常: ${e}` };
		}
	}

	async delete(filename: string): Promise<{ success: boolean; error?: string }> {
		if (!this.token) {
			return { success: false, error: "SM.MS Token 未配置" };
		}

		// SM.MS v2 API 需要通过 hash 删除，这里先查询获取 hash
		try {
			const historyRes = await fetch(`${SMMS_API}/upload_history`, {
				headers: { Authorization: this.token },
			});

			if (!historyRes.ok) return { success: false, error: "查询文件失败" };

			const historyData = await historyRes.json();
			if (!historyData.success || !Array.isArray(historyData.data)) {
				return { success: false, error: "查询文件列表失败" };
			}

			const target = historyData.data.find(
				(item: any) => item.filename === filename || item.origin_name === filename
			);

			if (!target || !target.hash) {
				return { success: false, error: "未找到文件" };
			}

			const deleteRes = await fetch(`${SMMS_API}/delete/${target.hash}`, {
				method: "GET",
				headers: { Authorization: this.token },
			});

			const deleteData = await deleteRes.json();
			if (!deleteData.success) {
				return { success: false, error: deleteData.message || "删除失败" };
			}

			return { success: true };
		} catch (e) {
			return { success: false, error: `删除异常: ${e}` };
		}
	}

	/**
	 * 测试连接：尝试获取上传历史（验证 Token 有效性）
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.token) return { success: false, error: "Token 未配置" };

		try {
			const response = await fetch(`${SMMS_API}/upload_history`, {
				headers: { Authorization: this.token },
			});

			if (response.ok || response.status === 401) {
				// 401 也算网络通，只是 token 问题
				const data = await response.json();
				if (data.success === false && data.message) {
					return { success: false, error: data.message };
				}
				return { success: true };
			}
			if (response.status === 401) return { success: false, error: "Token 无效" };

			return { success: false, error: `HTTP ${response.status}` };
		} catch (e) {
			return { success: false, error: `连接异常: ${e}` };
		}
	}

	async createDirectory(_dirName: string): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "SM.MS 不支持创建目录" };
	}
}
