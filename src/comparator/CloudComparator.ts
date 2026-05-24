/**
 * 模块3：本地 ↔ 云端比对器
 * 检查本地图片是否已上传至图床
 * 支持 GitHub、阿里云 OSS、腾讯云 COS
 *
 * 比对策略：
 * - 阿里云/腾讯云：优先使用云端文件列表按文件名匹配（避免 CORS 问题）
 * - GitHub：使用 HEAD 请求（raw.githubusercontent.com 通常允许跨域）
 */

import { ImageLink, ImageLMgrSettings, CompareResult, ImageBedType, CloudFile } from "../types";

export class CloudComparator {
	private settings: ImageLMgrSettings;

	constructor(settings: ImageLMgrSettings) {
		this.settings = settings;
	}

	updateSettings(settings: ImageLMgrSettings) {
		this.settings = settings;
	}

	/**
	 * 比对本地图片与云端
	 * @param cloudFiles 可选的云端文件列表，传入后将优先用于文件名匹配（避免 CORS）
	 */
	async compare(
		localImages: ImageLink[],
		bedType: ImageBedType = ImageBedType.GitHub,
		cloudFiles?: CloudFile[]
	): Promise<Map<string, CompareResult>> {
		const result = new Map<string, CompareResult>();

		if (!this.isBedSupported(bedType)) {
			for (const img of localImages) {
				result.set(img.pure, { exists: false });
			}
			return result;
		}

	// ===== 阿里云/腾讯云：优先用云端文件列表做文件名匹配（避免 CORS） =====
	// 只要传入了 cloudFiles 参数就走此路径（包括空数组），绝不回退到 HEAD 请求
	if ((bedType === ImageBedType.Aliyun || bedType === ImageBedType.Tencent) && cloudFiles) {
			// 构建云端文件名集合（仅文件，排除目录项）
			const cloudFileNames = new Set<string>();
			const cloudFileMap = new Map<string, string>(); // fileName → url
			for (const f of cloudFiles) {
				if (!f.isDirectory && f.prefix) {
					const name = f.prefix.split("/").pop() || f.name;
					cloudFileNames.add(name);
					cloudFileMap.set(name, f.url);
				}
			}

			for (const img of localImages) {
				if (img.type !== "local") {
					result.set(img.pure, { exists: false });
					continue;
				}
				const fileName = extractFileName(img.pure);
				const expectedUrl = this.generateExpectedUrl(img.pure, bedType);

				if (fileName && cloudFileNames.has(fileName)) {
					result.set(img.pure, { exists: true, url: cloudFileMap.get(fileName) || expectedUrl });
				} else {
					result.set(img.pure, { exists: false, url: expectedUrl });
				}
			}
			return result;
		}

		// ===== GitHub 或无云端列表时：回退到 HTTP HEAD 请求 =====
		const checks = localImages.map(async (img) => {
			if (img.type !== "local") {
				return { key: img.pure, value: { exists: false } as CompareResult };
			}

			const expectedUrl = this.generateExpectedUrl(img.pure, bedType);
			if (!expectedUrl) {
				return { key: img.pure, value: { exists: false } as CompareResult };
			}

			const exists = await this.checkUrlExists(expectedUrl);
			return { key: img.pure, value: { exists, url: expectedUrl } as CompareResult };
		});

		const results = await Promise.allSettled(checks);
		for (const r of results) {
			if (r.status === "fulfilled") {
				result.set(r.value.key, r.value.value);
			}
		}

		return result;
	}

	/**
	 * 判断图床是否支持 URL 比对
	 */
	private isBedSupported(bedType: ImageBedType): boolean {
		switch (bedType) {
			case ImageBedType.GitHub:
				return !!(this.settings.githubOwner && this.settings.githubRepo);
			case ImageBedType.Aliyun:
				return !!(this.settings.aliyunEndpoint && this.settings.aliyunBucket);
			case ImageBedType.Tencent:
				return !!(this.settings.tencentBucket && this.settings.tencentRegion);
			default:
				return false;
		}
	}

	private generateExpectedUrl(localPure: string, bedType: ImageBedType): string | undefined {
		switch (bedType) {
			case ImageBedType.GitHub:
				return this.generateGitHubUrl(localPure);
			case ImageBedType.Aliyun:
				return this.generateAliyunUrl(localPure);
			case ImageBedType.Tencent:
				return this.generateTencentUrl(localPure);
			default:
				return undefined;
		}
	}

	private generateGitHubUrl(localPure: string): string | undefined {
		const { githubOwner, githubRepo, githubBranch, githubPath } = this.settings;
		if (!githubOwner || !githubRepo) return undefined;

		const fileName = extractFileName(localPure);
		if (!fileName) return undefined;

		const basePath = githubPath ? `${githubPath}/` : "";
		return `https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/${githubBranch}/${basePath}${fileName}`;
	}

	private generateAliyunUrl(localPure: string): string | undefined {
		const { aliyunEndpoint, aliyunBucket } = this.settings;
		if (!aliyunEndpoint || !aliyunBucket) return undefined;

		const fileName = extractFileName(localPure);
		if (!fileName) return undefined;

		const ep = aliyunEndpoint.replace(/^https?:\/\//, "");
		return `https://${aliyunBucket}.${ep}/images/${fileName}`;
	}

	private generateTencentUrl(localPure: string): string | undefined {
		const { tencentBucket, tencentRegion } = this.settings;
		if (!tencentBucket || !tencentRegion) return undefined;

		const fileName = extractFileName(localPure);
		if (!fileName) return undefined;

		return `https://${tencentBucket}.cos.${tencentRegion}.myqcloud.com/images/${fileName}`;
	}

	private async checkUrlExists(url: string): Promise<boolean> {
		try {
			const response = await fetch(url, { method: "HEAD" });
			return response.ok;
		} catch {
			return false;
		}
	}
}

/** 共享的文件名提取工具函数 */
export function extractFileName(localPure: string): string | undefined {
	const normalized = localPure.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || undefined;
}
