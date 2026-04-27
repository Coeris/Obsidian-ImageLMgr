/**
 * 核心类型定义
 */

export interface ImageLink {
	/** 原始完整链接（含 | 参数） */
	raw: string;
	/** 纯净路径/URL（剥离 | 之后内容） */
	pure: string;
	/** 显示参数（| 后面的内容，如 500|center） */
	params: string;
	/** 类型：local / https / http */
	type: "local" | "https" | "http";
	/** 全库使用次数 */
	count: number;
	/** 使用位置（文件路径列表） */
	files: string[];
	/** 首次出现的行号（1-based） */
	line?: number;
	/** 解析后的库内绝对路径（由 metadataCache 解析相对路径得到） */
	resolvedPath?: string;
}

/** 快捷筛选按钮配置 */
export interface QuickFilterConfig {
	key: "local" | ImageBedType | string;
	label: string;
	enabled: boolean;
	/** 自定义图标（内联 SVG）；为空则根据 key 自动匹配 */
	icon?: string;
}

export interface ImageLMgrSettings {
	// ========== 插件通用设置 ==========
	/** 默认图床类型 */
	defaultBed: ImageBedType;
	/** 视图打开时自动刷新 */
	autoRefreshOnOpen: boolean;
	/** 显示云端未引用文件 */
	showUnreferenced: boolean;
	/** 刷新防抖延迟(ms) */
	debounceDelay: number;

	// ========== WebDAV 同步 ==========
	/** 启用 WebDAV 同步图床配置 */
	webdavEnable: boolean;
	/** WebDAV 服务器地址（如 https://example.com/webdav/） */
	webdavUrl: string;
	/** WebDAV 用户名 */
	webdavUsername: string;
	/** WebDAV 密码 */
	webdavPassword: string;
	/** 远程配置文件路径（如 /ImageLMgr/settings.json） */
	webdavRemotePath: string;
	/** WebDAV 自动同步：设置保存时自动上传 */
	webdavAutoSync: boolean;

	// ========== 图床配置 ==========
	githubToken: string;
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	githubPath: string;
	aliyunEndpoint: string;
	aliyunBucket: string;
	aliyunAccessKeyId: string;
	aliyunAccessKeySecret: string;
	tencentSecretId: string;
	tencentSecretKey: string;
	tencentBucket: string;
	tencentRegion: string;
	smmsToken: string;

	// ========== 快捷筛选 ==========
	quickFilterButtons: QuickFilterConfig[];
}

export enum ImageBedType {
	GitHub = "GitHub",
	Aliyun = "阿里云 OSS",
	Tencent = "腾讯云 COS",
	Other = "其他图床",
}

export interface CloudFile {
	name: string;
	url: string;
	/** 是否为目录 */
	isDirectory?: boolean;
	/** 完整 object key（含路径前缀） */
	prefix?: string;
}

export interface UploadResult {
	success: boolean;
	url?: string;
	error?: string;
}

export interface CompareResult {
	exists: boolean;
	url?: string;
}
