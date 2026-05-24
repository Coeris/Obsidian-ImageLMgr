/**
 * ImageLMgr - 图床管理助手
 * Obsidian 纯文本图片链接管理工具
 */

import { Plugin, Notice, TFile } from "obsidian";
import { ImageLMgrSettingTab } from "./settings/SettingTab";
import { ImageLMgrView, VIEW_TYPE_IMAGE_LMGR } from "./view/ImageLMgrView";
import { LinkParser } from "./parser/LinkParser";
import { VaultScanner } from "./scanner/VaultScanner";
import { CloudComparator } from "./comparator/CloudComparator";
import { ImageBedManager } from "./imagebed/ImageBedManager";
import { GitHubImageBed } from "./imagebed/GitHubImageBed";
import { AliyunOssImageBed } from "./imagebed/AliyunOssImageBed";
import { TencentCosImageBed } from "./imagebed/TencentCosImageBed";
import { SmmsImageBed } from "./imagebed/SmmsImageBed";
import { ImageLink, ImageLMgrSettings, ImageBedType, CloudFile } from "./types";
import { HashCache } from "./utils/HashCache";
import { parseFrontmatter } from "./utils/FrontmatterParser";
import { encryptSensitiveFields, decryptSensitiveFields } from "./utils/SecureStorage";

const DEFAULT_SETTINGS: ImageLMgrSettings = {
	// 插件通用设置
	autoRefreshOnOpen: true,
	showUnreferenced: true,
	debounceDelay: 500,

	// WebDAV 同步
	webdavEnable: false,
	webdavUrl: "",
	webdavUsername: "",
	webdavPassword: "",
	webdavRemotePath: "/ImageLMgr/settings.json",
	webdavAutoSync: false,

	// 图床配置
	githubToken: "",
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubPath: "images",
	aliyunEndpoint: "",
	aliyunBucket: "",
	aliyunAccessKeyId: "",
	aliyunAccessKeySecret: "",
	tencentSecretId: "",
	tencentSecretKey: "",
	tencentBucket: "",
	tencentRegion: "",
	smmsToken: "",

	// 快捷筛选按钮（默认全部启用）
	quickFilterButtons: [
		{ key: "local", label: "本地图片", enabled: true },
		{ key: ImageBedType.GitHub, label: "GitHub", enabled: true },
		{ key: ImageBedType.Aliyun, label: "阿里云 OSS", enabled: true },
		{ key: ImageBedType.Tencent, label: "腾讯云 COS", enabled: true },
		{ key: ImageBedType.Other, label: "其他图床", enabled: true },
	],
};

export default class ImageLMgrPlugin extends Plugin {
	settings: ImageLMgrSettings = DEFAULT_SETTINGS;
	view: ImageLMgrView | null = null;
	linkParser: LinkParser;
	vaultScanner: VaultScanner;
	cloudComparator: CloudComparator;
	imageBedManager: ImageBedManager;
	/** 图片去重哈希缓存 */
	hashCache: HashCache = new HashCache();
	/** WebDAV 同步元数据 */
	private webdavMeta: { lastSyncedAt?: string; lastSyncSource?: string } | null = null;

	async onload() {
		await this.loadSettings();

		// 开发模式热加载检测
		this.startDevReloadWatch();

		// 初始化核心模块
		this.linkParser = new LinkParser();
		this.vaultScanner = new VaultScanner(this.app, this.linkParser);
		this.cloudComparator = new CloudComparator(this.settings);
		this.imageBedManager = new ImageBedManager();

		// 注册图床
		this.registerImageBeds();

		// 注册视图
		this.registerView(VIEW_TYPE_IMAGE_LMGR, (leaf) => {
			this.view = new ImageLMgrView(leaf, this);
			return this.view;
		});

		// 添加功能区按钮 - 打开面板
		this.addRibbonIcon("cloud-check", "打开图床管理面板", () => {
			this.activateView();
		});

		// 添加命令 - 打开面板
		this.addCommand({
			id: "open-imagelmgr",
			name: "打开图床管理面板",
			callback: () => this.activateView(),
		});

		// 添加命令 - 刷新扫描
		this.addCommand({
			id: "refresh-imagelmgr",
			name: "刷新图片扫描",
			callback: () => this.refreshView(),
		});

		// 监听文件变更事件
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.onFileChanged(file.path);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.onFileChanged(file.path);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.onFileChanged(file.path);
				}
			})
		);

		// 监听活跃文件切换
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.onActiveFileChanged();
			})
		);

		// 注册设置面板
		this.addSettingTab(new ImageLMgrSettingTab(this.app, this));
	}

	onunload() {
		// 清理
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_IMAGE_LMGR);
	}

	private registerImageBeds() {
		const github = new GitHubImageBed();
		github.configure(this.settings);
		this.imageBedManager.register(ImageBedType.GitHub, github);

		const aliyun = new AliyunOssImageBed();
		aliyun.configure(this.settings);
		this.imageBedManager.register(ImageBedType.Aliyun, aliyun);

		const tencent = new TencentCosImageBed();
		tencent.configure(this.settings);
		this.imageBedManager.register(ImageBedType.Tencent, tencent);

		const smms = new SmmsImageBed();
		smms.configure(this.settings);
		this.imageBedManager.register(ImageBedType.Other, smms);
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_IMAGE_LMGR);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const newLeaf = this.app.workspace.getLeaf('tab');
		if (newLeaf) {
			await newLeaf.setViewState({ type: VIEW_TYPE_IMAGE_LMGR, active: true });
			this.app.workspace.revealLeaf(newLeaf);
		}
	}

	async onFileChanged(_filePath: string) {
		// 防抖：延迟更新视图
		this.debounceRefresh();
	}

	async onActiveFileChanged() {
		this.debounceRefresh();
	}

	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	private debounceRefresh() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.refreshView();
		}, this.settings.debounceDelay);
	}

	refreshView() {
		if (this.view) {
			this.view.refresh();
		}
	}

	async loadSettings() {
		const data = await this.loadData() || {};
		const { _hashcache, _webdavmeta, ...settingsData } = data;
		const raw = Object.assign({}, DEFAULT_SETTINGS, settingsData);
		// 解密敏感字段（自动兼容旧的明文数据）
		const salt = `imagelmgr:${this.app.vault.getName()}`;
		this.settings = await decryptSensitiveFields(raw, salt) as ImageLMgrSettings;
		// 恢复去重缓存
		if (_hashcache && typeof _hashcache === "string") {
			this.hashCache = new HashCache(_hashcache);
		}
		// 恢复 WebDAV 同步元数据
		if (_webdavmeta) {
			this.webdavMeta = _webdavmeta;
		}
	}

	async saveSettings() {
		// 加密敏感字段后保存
		const salt = `imagelmgr:${this.app.vault.getName()}`;
		const encrypted = await encryptSensitiveFields(this.settings as any, salt);
		// 将 hash cache 和 webdav meta 合并到主数据对象
		const savePayload: any = { ...encrypted };
		if (this.hashCache.isDirty()) {
			savePayload._hashcache = this.hashCache.serialize();
			this.hashCache.markClean();
		}
		if (this.webdavMeta) {
			savePayload._webdavmeta = this.webdavMeta;
		}
		await this.saveData(savePayload);
		// 更新各图床配置
		for (const bed of this.imageBedManager.getAll()) {
			bed.configure(this.settings);
		}
		this.cloudComparator.updateSettings(this.settings);
		this.refreshView();
		// #11 WebDAV 自动同步：设置保存时自动上传
		if (this.settings.webdavEnable && this.settings.webdavAutoSync) {
			this.syncToRemoteSilent();
		}
	}

	/**
	 * 获取当前活跃笔记的图片链接
	 */
	async getCurrentFileImages(): Promise<ImageLink[]> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") return [];

		const content = await this.app.vault.read(activeFile);
		return this.linkParser.parse(content);
	}

	/**
	 * 获取全库图片链接统计
	 */
	async getVaultImages(): Promise<Map<string, ImageLink>> {
		return await this.vaultScanner.scan();
	}

	/**
	 * 比对本地图片与云端
	 * @param cloudFiles 可选的云端文件列表（用于文件名匹配，避免 CORS）
	 */
	async compareLocalWithCloud(
		localImages: ImageLink[],
		bedType?: ImageBedType,
		cloudFiles?: CloudFile[]
	): Promise<Map<string, { exists: boolean; url?: string }>> {
		return await this.cloudComparator.compare(localImages, bedType, cloudFiles);
	}

	/**
	 * 上传图片到图床
	 */
	async uploadImage(file: File, bedType: ImageBedType, imagePath?: string): Promise<{ success: boolean; url?: string; error?: string }> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return { success: false, error: "图床未注册" };

		return bed.upload(file, imagePath);
	}

	/**
	 * 替换本地链接为云端链接（保留 params）
	 */
	async replaceLink(img: ImageLink, newPure: string) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		const content = await this.app.vault.read(activeFile);
		let newContent: string;

		if (img.raw.startsWith("![[") && img.raw.endsWith("]]")) {
			// Wiki 链接格式: ![[pure|params]] -> ![[newPure|params]]
			const newWikiLink = img.params
				? `![[${newPure}|${img.params}]]`
				: `![[${newPure}]]`;
			newContent = content.split(img.raw).join(newWikiLink);
		} else {
			// Markdown 链接格式: ![alt](raw) -> ![alt](newPure)
			const escapedRaw = escapeRegex(img.raw);
			// 转义替换字符串中的 $ 防止被当作反向引用
			const safeReplacement = `$1${newPure.replace(/\$/g, "$$$$")}$2`;
			newContent = content.replace(
				new RegExp(`(!\\[[^\\]]*\\]\\()${escapedRaw}(\\))`, "g"),
				safeReplacement
			);
		}

		if (newContent !== content) {
			await this.app.vault.modify(activeFile, newContent);
		}
	}

	/**
	 * 删除云端文件
	 */
	async deleteCloudFile(filename: string, bedType: ImageBedType): Promise<{ success: boolean; error?: string }> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return { success: false, error: "图床未注册" };

		return bed.delete(filename);
	}

	/**
	 * 获取云端文件列表
	 */
	async listCloudFiles(bedType: ImageBedType): Promise<CloudFile[]> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return [];

		return bed.listFiles();
	}

	/**
	 * 创建云端目录
	 */
	async createCloudDirectory(dirName: string, bedType: ImageBedType): Promise<{ success: boolean; error?: string }> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return { success: false, error: "图床未注册" };

		return bed.createDirectory(dirName);
	}

	/**
	 * #6 测试图床连接
	 */
	async testBedConnection(bedType: ImageBedType): Promise<{ success: boolean; error?: string }> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return { success: false, error: "图床未注册" };
		if (bed.testConnection) return bed.testConnection();
		return { success: false, error: "该图床不支持连接测试" };
	}

	async testCreateDirectoryCapability(bedType: ImageBedType): Promise<{ supported: boolean; reason?: string }> {
		const bed = this.imageBedManager.get(bedType);
		if (!bed) return { supported: false, reason: "图床未注册" };
		if (bed.testCreateDirectoryCapability) return bed.testCreateDirectoryCapability();
		return { supported: false, reason: "未知是否支持创建目录" };
	}

	/**
	 * #5 带去重的图片上传
	 * 先计算文件哈希，命中缓存则直接返回已有 URL，避免重复上传
	 */
	async uploadImageWithDedup(
		file: File,
		bedType: ImageBedType,
		imagePath?: string
	): Promise<{ success: boolean; url?: string; error?: string; cached?: boolean }> {
		const hash = await HashCache.computeHash(file);
		const cached = this.hashCache.get(hash);

		// 缓存命中且同一图床 → 直接返回 URL
		if (cached && cached.bedType === bedType) {
			return { success: true, url: cached.url, cached: true };
		}

		// 执行上传
		const result = await this.uploadImage(file, bedType, imagePath);
		if (result.success && result.url) {
			this.hashCache.set(hash, {
				hash,
				url: result.url,
				bedType,
				fileName: file.name,
				uploadedAt: Date.now(),
			});
			// 立即持久化缓存变更
			try {
				const data = (await this.loadData()) || {};
				data._hashcache = this.hashCache.serialize();
				await this.saveData(data);
				this.hashCache.markClean();
			} catch { /* 静默失败，下次保存时补写 */ }
		}

		return { ...result, cached: false };
	}

	/**
	 * #11 WebDAV 静默自动上传（不弹 Notice）
	 */
	private async syncToRemoteSilent() {
		if (!this.settings.webdavEnable || !this.settings.webdavUrl) return;
		if (!this.settings.webdavUrl.startsWith("https://")) {
			console.warn("[ImageLMgr] WebDAV 仅支持 HTTPS，已跳过同步");
			return;
		}

		try {
			const url = `${this.settings.webdavUrl}${this.settings.webdavRemotePath.replace(/^\//, "")}`;
			const auth = btoa(`${this.settings.webdavUsername}:${this.settings.webdavPassword}`);

			const bedData: Record<string, string> = {};
			const bedKeys = [
				"githubToken", "githubOwner", "githubRepo", "githubBranch", "githubPath",
				"aliyunEndpoint", "aliyunBucket", "aliyunAccessKeyId", "aliyunAccessKeySecret",
				"tencentSecretId", "tencentSecretKey", "tencentBucket", "tencentRegion",
				"smmsToken",
			];
			for (const k of bedKeys) {
				bedData[k] = (this.settings as any)[k];
			}
			bedData._syncedAt = new Date().toISOString();

			await fetch(url, {
				method: "PUT",
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(bedData, null, 2),
			});
		} catch {
			// 自动同步静默失败，不打扰用户
		}
	}

	/**
	 * #11 从服务器下载并带冲突检测
	 * @returns 冲突信息或 null
	 */
	async syncFromRemoteWithConflict(): Promise<{
		success: boolean;
		error?: string;
		conflict?: boolean;  // 是否存在冲突
		remoteNewer?: boolean; // 远程更新
		localNewer?: boolean;  // 本地更新
	} | null> {
		if (!this.settings.webdavEnable || !this.settings.webdavUrl) {
			return { success: false, error: "请先启用 WebDAV 并填写服务器地址", conflict: false };
		}
		if (!this.settings.webdavUrl.startsWith("https://")) {
			return { success: false, error: "WebDAV 仅支持 HTTPS 连接", conflict: false };
		}

		let localSyncedAt: string | undefined;
		let remoteSyncedAt: string | undefined;

		try {
			const url = `${this.settings.webdavUrl}${this.settings.webdavRemotePath.replace(/^\//, "")}`;
			const auth = btoa(`${this.settings.webdavUsername}:${this.settings.webdavPassword}`);

			// 获取远程数据
			const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
			if (!response.ok) {
				return { success: false, error: `下载失败: HTTP ${response.status}`, conflict: false };
			}

			const remoteData = await response.json();
			if (!remoteData || typeof remoteData !== "object") {
				return { success: false, error: "远程数据格式无效", conflict: false };
			}

			remoteSyncedAt = remoteData._syncedAt;

			// 尝试获取本地上次同步时间
			if (this.webdavMeta) localSyncedAt = this.webdavMeta.lastSyncedAt;

			// 冲突检测：两边都有更新
			if (localSyncedAt && remoteSyncedAt) {
				const localTime = new Date(localSyncedAt).getTime();
				const remoteTime = new Date(remoteSyncedAt).getTime();
				const now = Date.now();

				// 如果远程比本地上次同步时间更新，且本地也有未同步的修改 → 冲突
				if (Math.abs(localTime - remoteTime) > 5000) {
					// 差异超过5秒视为有潜在冲突
					const conflict = localTime < remoteTime ? "remote_newer" : "local_newer";
					return {
						success: false,
						error: "检测到配置可能存在冲突",
						conflict: true,
						remoteNewer: conflict === "remote_newer",
						localNewer: conflict === "local_newer",
					};
				}
			}

			// 无冲突，执行合并
			const mergeKeys = [
				"githubToken", "githubOwner", "githubRepo", "githubBranch", "githubPath",
				"aliyunEndpoint", "aliyunBucket", "aliyunAccessKeyId", "aliyunAccessKeySecret",
				"tencentSecretId", "tencentSecretKey", "tencentBucket", "tencentRegion",
				"smmsToken",
			];

			let changed = false;
			for (const k of mergeKeys) {
				if (k in remoteData && typeof remoteData[k] === "string") {
					if ((this.settings as any)[k] !== remoteData[k]) changed = true;
					(this.settings as any)[k] = remoteData[k];
				}
			}

			// 更新同步元数据
			this.webdavMeta = {
				lastSyncedAt: new Date().toISOString(),
				lastSyncSource: "download",
			};

			await this.saveSettings();
			return { success: true, conflict: false };
		} catch (e) {
			return { success: false, error: `下载异常: ${e}`, conflict: false };
		}
	}

	/**
	 * #10 解析当前活跃文件的 Frontmatter 配置
	 */
	async getFileFrontmatter(): Promise<Record<string, string | boolean | null>> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") return {};

		const content = await this.app.vault.read(activeFile);
		const config = parseFrontmatter(content);
		if (!config) return {};

		const result: Record<string, string | boolean | null> = {};
		if (config.imageBed !== undefined) result.imageBed = config.imageBed;
		if (config.autoUpload !== undefined) result.autoUpload = config.autoUpload;
		if (config.imagePath !== undefined) result.imagePath = config.imagePath;
		return result;
	}

// ==================== 开发模式热加载 ====================

/** 开发模式：检测 main.js 修改时间变化时自动刷新视图 */
private startDevReloadWatch() {
	// 仅在 Electron 环境下启用
	if (!("require" in window)) return;

	try {
		const fs = (window as any).require("fs");
		const path = (window as any).require("path");
		const mainJsPath = path.join(this.manifest.dir, "main.js");

		let lastMtime = "";
		const interval = setInterval(() => {
			try {
				const stat = fs.statSync(mainJsPath);
				const mtime = stat.mtimeMs.toString();
				if (mtime && mtime !== lastMtime) {
					lastMtime = mtime;
					console.log("[ImageLMgr] hot reload: main.js changed, refreshing view...");
					this.refreshView?.();
				}
			} catch {}
		}, 1000);

		this.register(() => clearInterval(interval));
	} catch {
		// 非 Electron 环境，跳过
	}
}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
