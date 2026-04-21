/**
 * 模块3：本地 ↔ 云端比对器
 * 检查本地图片是否已上传至图床
 * 支持 GitHub、阿里云 OSS、腾讯云 COS
 */

import { ImageLink, ImageLMgrSettings, CompareResult, ImageBedType } from "../types";

export class CloudComparator {
	private settings: ImageLMgrSettings;

	constructor(settings: ImageLMgrSettings) {
		this.settings = settings;
	}

	updateSettings(settings: ImageLMgrSettings) {
		this.settings = settings;
	}

	/**
	 * 比对本地图片与云端（并行请求）
	 */
	async compare(
		localImages: ImageLink[],
		bedType: ImageBedType = ImageBedType.GitHub
	): Promise<Map<string, CompareResult>> {
		const result = new Map<string, CompareResult>();

		if (!this.isBedSupported(bedType)) {
			// 图床未配置或暂不支持比对，全部返回未上传
			for (const img of localImages) {
				result.set(img.pure, { exists: false });
			}
			return result;
		}

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

	private generateExpectedUrl(localPure: string, bedType: ImageBedType): string | null {
		switch (bedType) {
			case ImageBedType.GitHub:
				return this.generateGitHubUrl(localPure);
			case ImageBedType.Aliyun:
				return this.generateAliyunUrl(localPure);
			case ImageBedType.Tencent:
				return this.generateTencentUrl(localPure);
			default:
				return null;
		}
	}

	private generateGitHubUrl(localPure: string): string | null {
		const { githubOwner, githubRepo, githubBranch, githubPath } = this.settings;
		if (!githubOwner || !githubRepo) return null;

		const fileName = extractFileName(localPure);
		if (!fileName) return null;

		const basePath = githubPath ? `${githubPath}/` : "";
		return `https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/${githubBranch}/${basePath}${fileName}`;
	}

	private generateAliyunUrl(localPure: string): string | null {
		const { aliyunEndpoint, aliyunBucket } = this.settings;
		if (!aliyunEndpoint || !aliyunBucket) return null;

		const fileName = extractFileName(localPure);
		if (!fileName) return null;

		const ep = aliyunEndpoint.replace(/^https?:\/\//, "");
		return `https://${aliyunBucket}.${ep}/images/${fileName}`;
	}

	private generateTencentUrl(localPure: string): string | null {
		const { tencentBucket, tencentRegion } = this.settings;
		if (!tencentBucket || !tencentRegion) return null;

		const fileName = extractFileName(localPure);
		if (!fileName) return null;

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
export function extractFileName(localPure: string): string | null {
	const normalized = localPure.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || null;
}
