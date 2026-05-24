/**
 * Frontmatter 解析工具
 * 从 Markdown 文件头部提取 YAML 配置
 */

export interface FrontmatterConfig {
	/** 指定该文件使用的图床（覆盖全局默认） */
	imageBed?: string;
	/** 是否启用自动上传（粘贴即上传等场景） */
	autoUpload?: boolean;
	/** 该文件图片的云端路径前缀 */
	imagePath?: string;
}

/**
 * 从文件内容中提取 YAML frontmatter
 * 支持标准 --- 包围的格式
 */
export function parseFrontmatter(content: string): FrontmatterConfig | null {
	// 匹配 --- ... --- 格式
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match || !match[1]) return null;

	const yaml = match[1];
	const config: FrontmatterConfig = {};

	// image-bed 或 imageBed
	const bedMatch = yaml.match(/^(?:image[-_]?bed)\s*:\s*(.+)$/im);
	if (bedMatch) config.imageBed = bedMatch[1].trim();

	// auto-upload 或 autoUpload
	const autoMatch = yaml.match(/^(?:auto[-_]?upload)\s*:\s*(true|false)$/im);
	if (autoMatch) config.autoUpload = autoMatch[1] === "true";

	// image-path 或 imagePath
	const pathMatch = yaml.match(/^(?:image[-_]?path)\s*:\s*(.+)$/im);
	if (pathMatch) config.imagePath = pathMatch[1].trim().replace(/^["']|["']$/g, "");

	// 如果没有任何有效字段，返回 null
	if (config.imageBed === undefined &&
		config.autoUpload === undefined &&
		config.imagePath === undefined) {
		return null;
	}

	return config;
}
