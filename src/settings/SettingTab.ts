/**
 * ImageLMgr 设置面板
 * 折叠式布局：插件设置 + WebDAV同步 + 图床配置
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import ImageLMgrPlugin from "../main";
import { ImageBedType, QuickFilterConfig } from "../types";
import { getBedFaviconSvg, getFilterButtonIcon, isValidSvg } from "../icons";

interface BedConfig {
	name: string;
	desc: string;
	guide: string;
	fields: { name: string; desc: string; placeholder: string; key: string; isSecret?: boolean }[];
}

/** 图床名称 → 类型映射 */
const BED_NAME_TYPE_MAP: Record<string, ImageBedType> = {
	"GitHub 图床": ImageBedType.GitHub,
	"阿里云 OSS": ImageBedType.Aliyun,
	"腾讯云 COS": ImageBedType.Tencent,
	"其他图床": ImageBedType.Other,
};

const BED_CONFIGS: BedConfig[] = [
	{
		name: "GitHub 图床",
		desc: "使用 GitHub 仓库作为图床",
		guide:
			"1. 打开 GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)\n" +
			"2. 点击「Generate new token (classic)」，勾选 repo 权限，生成 Token\n" +
			"3. 创建一个公开仓库用于存储图片（如 image-repo）\n" +
			"4. Owner 填你的 GitHub 用户名，Repo 填仓库名，Branch 填 main\n" +
			"5. Path 可选填子路径（如 images），图片将存到该目录下",
		fields: [
			{ name: "Token", desc: "GitHub PAT（需要 repo 权限）", placeholder: "ghp_xxxx", key: "githubToken" },
			{ name: "Owner", desc: "GitHub 用户名或组织名", placeholder: "username", key: "githubOwner" },
			{ name: "Repo", desc: "存放图片的仓库名", placeholder: "my-repo", key: "githubRepo" },
			{ name: "Branch", desc: "分支名（通常为 main）", placeholder: "main", key: "githubBranch" },
			{ name: "Path", desc: "图片存储路径（如 images）", placeholder: "images", key: "githubPath" },
		],
	},
	{
		name: "阿里云 OSS",
		desc: "阿里云对象存储服务，前端直传模式",
		guide:
			"1. 登录阿里云控制台 → 对象存储 OSS → 创建 Bucket（建议选择「公共读」或保持私有均可）\n" +
			"2. 在 Bucket 概览页面找到 Endpoint（外网访问端点），复制完整 URL\n" +
			"3. 控制台右上角头像 → AccessKey 管理 → 创建 AccessKey\n" +
			"   安全建议：使用 RAM 子账号，仅授予 AliyunOSSFullAccess 权限\n" +
			"4. 进入 Bucket → 数据安全 → 跨域设置 → 创建规则：\n" +
			"   来源填：app://obsidian.md, capacitor://localhost, http://localhost\n" +
			"   方法填：GET, PUT, DELETE\n" +
			"5. 若 Bucket 为私有读，图片链接需签名才能访问",
		fields: [
			{ name: "Endpoint", desc: "OSS 外网端点（Bucket 概览页可查）", placeholder: "https://oss-cn-hangzhou.aliyuncs.com", key: "aliyunEndpoint" },
			{ name: "Bucket", desc: "存储桶名称", placeholder: "my-bucket", key: "aliyunBucket" },
			{ name: "AccessKey ID", desc: "RAM 控制台获取", placeholder: "LTAI...", key: "aliyunAccessKeyId" },
			{ name: "AccessKey Secret", desc: "密钥密码", placeholder: "", key: "aliyunAccessKeySecret", isSecret: true },
		],
	},
	{
		name: "腾讯云 COS",
		desc: "腾讯云对象存储服务，前端直传模式",
		guide:
			"1. 登录腾讯云控制台 → 对象存储 → 创建存储桶\n" +
			"2. 控制台右上角头像 → 访问管理 → API 密钥管理 → 新建密钥\n" +
			"   安全建议：创建 CAM 子用户，仅授予 QcloudCOSDataFullAccess 权限\n" +
			"3. Bucket 格式为「名称-APPID」（在存储桶列表中可看到完整格式）\n" +
			"4. Region 为地域简称（如 ap-guangzhou、ap-shanghai）\n" +
			"5. 存储桶需配置 CORS 规则允许跨域请求",
		fields: [
			{ name: "SecretId", desc: "API 密钥的 SecretId", placeholder: "AKID...", key: "tencentSecretId" },
			{ name: "SecretKey", desc: "密钥密码", placeholder: "", key: "tencentSecretKey", isSecret: true },
			{ name: "Bucket", desc: "存储桶名-APPID（如 mybucket-1234567890）", placeholder: "bucket-1250000000", key: "tencentBucket" },
			{ name: "Region", desc: "地域（如 ap-guangzhou）", placeholder: "ap-guangzhou", key: "tencentRegion" },
		],
	},
	{
		name: "其他图床",
		desc: "其他网络图片（非 GitHub/阿里云/腾讯云）",
		guide:
			"1. 其他图床用于显示所有不属于内置图床的网络图片\n" +
			"2. 可通过「快捷筛选」添加自定义域名按钮，添加后该域名的图片将独立显示\n" +
			"3. 未匹配到自定义域名的图片统一归类在此",
		fields: [
			{ name: "API Token", desc: "SM.MS 图床 Token（可选，用于上传功能）", placeholder: "your-token", key: "smmsToken" },
		],
	},
];

/** 防抖保存计时器 */
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖保存设置：延迟 600ms 后真正写入，
 * 避免用户快速输入时每个字符都触发 saveSettings → 刷新视图 → WebDAV上传
 */
function debouncedSaveSettings(plugin: ImageLMgrPlugin): void {
	if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
	settingsSaveTimer = setTimeout(async () => {
		try { await plugin.saveSettings(); } catch { /* 静默 */ }
		settingsSaveTimer = null;
	}, 600);
}

export class ImageLMgrSettingTab extends PluginSettingTab {
	private plugin: ImageLMgrPlugin;

	/** 同步操作进行中标志，防止重复点击 */
	private syncing = false;

	/** 同步状态元素引用 */
	private webdavStatusEl: HTMLDivElement | null = null;

	constructor(app: App, plugin: ImageLMgrPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "ImageLMgr 设置" });

		this.renderGeneralSettings(containerEl);
		this.renderWebdavSettings(containerEl);
		this.renderQuickFilterSettings(containerEl);

		for (const bed of BED_CONFIGS) {
			this.renderCollapsibleBed(containerEl, bed);
		}
	}

	// ========== 插件通用设置 ==========

	private renderGeneralSettings(container: HTMLElement) {
		const collapsible = container.createDiv({ cls: "imagelmgr-collapsible" });

		const header = collapsible.createDiv({ cls: "imagelmgr-collapsible-header" });
		const titleRow = header.createDiv({ cls: "imagelmgr-collapsible-title-row" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-arrow", text: "▼" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-title", text: "插件设置" });
		header.createSpan({ cls: "imagelmgr-collapsible-subtitle", text: "视图行为、显示选项等通用配置" });

		const content = collapsible.createDiv({ cls: "imagelmgr-collapsible-content" });
		content.style.display = "";

		new Setting(content)
			.setName("默认图床")
			.setDesc("打开面板时默认选中的图床类型")
			.addDropdown((dd) => dd
				.addOption(ImageBedType.GitHub, "GitHub")
				.addOption(ImageBedType.Aliyun, "阿里云 OSS")
				.addOption(ImageBedType.Tencent, "腾讯云 COS")
				.addOption(ImageBedType.Other, "其他图床")
				.setValue(this.plugin.settings.defaultBed)
				.onChange((value) => {
					this.plugin.settings.defaultBed = value as ImageBedType;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("打开时自动刷新")
			.setDesc("每次打开视图时自动重新扫描和比对")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoRefreshOnOpen)
				.onChange((value) => {
					this.plugin.settings.autoRefreshOnOpen = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("显示云端未引用文件")
			.setDesc("在列表底部展示云端存在但笔记中未引用的文件")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showUnreferenced)
				.onChange((value) => {
					this.plugin.settings.showUnreferenced = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("防抖延迟(ms)")
			.setDesc("文件变更后触发刷新的等待时间，值越大越省资源")
			.addText((text) => text
				.setPlaceholder("500")
				.setValue(String(this.plugin.settings.debounceDelay))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 100) {
						this.plugin.settings.debounceDelay = num;
						debouncedSaveSettings(this.plugin);
					}
				})
			);

		// #10 Frontmatter 说明
		content.createDiv({ cls: "imagelmgr-setting-guide", text: [
			"Frontmatter 级别控制（写在笔记头部 YAML 区域）：",
			"  image-bed: GitHub     → 指定该笔记使用的图床类型",
			"  auto-upload: false    → 关闭该笔记的自动上传",
			"  image-path: blog/2026/ → 指定该笔记图片的云端路径前缀",
			"",
			"示例：",
			"  ---",
			"  image-bed: aliyun",
			"  auto-upload: true",
			"  image-path: blog/",
			"  ---",
		].join("\n") });

		// 折叠/展开事件
		const arrowEl = titleRow.querySelector(".imagelmgr-collapsible-arrow") as HTMLSpanElement;
		header.addEventListener("click", () => {
			const isOpen = content.style.display !== "none";
			content.style.display = isOpen ? "none" : "";
			if (arrowEl) arrowEl.textContent = isOpen ? "▶" : "▼";
		});
	}

	// ========== WebDAV 同步 ==========

	private renderWebdavSettings(container: HTMLElement) {
		const collapsible = container.createDiv({ cls: "imagelmgr-collapsible" });

		const header = collapsible.createDiv({ cls: "imagelmgr-collapsible-header" });
		const titleRow = header.createDiv({ cls: "imagelmgr-collapsible-title-row" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-arrow", text: "▶" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-title", text: "WebDAV 同步" });
		header.createSpan({ cls: "imagelmgr-collapsible-subtitle", text: "通过 WebDAV 服务同步图床配置到多设备" });

		const content = collapsible.createDiv({ cls: "imagelmgr-collapsible-content" });
		content.style.display = "none";

		new Setting(content)
			.setName("启用 WebDAV 同步")
			.setDesc("开启后将自动上传/下载图床配置到远程服务器")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.webdavEnable)
				.onChange((value) => {
					this.plugin.settings.webdavEnable = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("服务器地址")
			.setDesc("WebDAV 服务器 URL（需以 / 结尾）")
			.addText((text) => text
				.setPlaceholder("https://example.com/webdav/")
				.setValue(this.plugin.settings.webdavUrl)
				.onChange((value) => {
					this.plugin.settings.webdavUrl = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("用户名")
			.addText((text) => text
				.setPlaceholder("username")
				.setValue(this.plugin.settings.webdavUsername)
				.onChange((value) => {
					this.plugin.settings.webdavUsername = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		new Setting(content)
			.setName("密码")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.placeholder = "输入密码";
				text.inputEl.value = this.plugin.settings.webdavPassword;
				text.inputEl.addEventListener("input", () => {
					this.plugin.settings.webdavPassword = text.inputEl.value;
					debouncedSaveSettings(this.plugin);
				});
				return text;
			});

		new Setting(content)
			.setName("远程路径")
			.setDesc("远程服务器上存储配置文件的路径")
			.addText((text) => text
				.setPlaceholder("/ImageLMgr/settings.json")
				.setValue(this.plugin.settings.webdavRemotePath)
				.onChange((value) => {
					this.plugin.settings.webdavRemotePath = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		// #11 自动同步开关
		new Setting(content)
			.setName("自动上传配置")
			.setDesc("每次保存设置时自动将图床配置上传到服务器（推荐多设备使用）")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.webdavAutoSync)
				.onChange((value) => {
					this.plugin.settings.webdavAutoSync = value;
					debouncedSaveSettings(this.plugin);
				})
			);

		const actionRow = content.createDiv({ cls: "imagelmgr-webdav-actions" });

		const uploadBtn = actionRow.createEl("button", {
			text: "上传配置到服务器",
			cls: "mod-cta imagelmgr-webdav-btn",
		});
		uploadBtn.addEventListener("click", () => this.syncToRemote(uploadBtn));

		const downloadBtn = actionRow.createEl("button", {
			text: "从服务器下载（智能合并）",
			cls: "imagelmgr-webdav-btn",
		});
		downloadBtn.addEventListener("click", () => this.syncFromRemoteSmart(downloadBtn));

		// #11 同步状态显示（可更新）
		this.webdavStatusEl = content.createDiv({ cls: "imagelmgr-webdav-status" });
		this.updateSyncStatus("点击上方按钮进行同步操作");

		// 折叠/展开事件
		const arrowEl = titleRow.querySelector(".imagelmgr-collapsible-arrow") as HTMLSpanElement;
		header.addEventListener("click", () => {
			const isOpen = content.style.display !== "none";
			content.style.display = isOpen ? "none" : "";
			if (arrowEl) arrowEl.textContent = isOpen ? "▶" : "▼";
		});
	}

	private async syncToRemote(btn?: HTMLButtonElement) {
		if (this.syncing) return;
		if (!this.plugin.settings.webdavEnable || !this.plugin.settings.webdavUrl) {
			new Notice("请先启用 WebDAV 并填写服务器地址");
			return;
		}

		this.syncing = true;
		this.setButtonLoading(btn, true);
		this.updateSyncStatus("正在上传...");

		try {
			const url = `${this.plugin.settings.webdavUrl}${this.plugin.settings.webdavRemotePath.replace(/^\//, "")}`;
			const auth = btoa(`${this.plugin.settings.webdavUsername}:${this.plugin.settings.webdavPassword}`);

			// 提取图床相关字段（不含插件通用设置）
			const bedData = {
				githubToken: this.plugin.settings.githubToken,
				githubOwner: this.plugin.settings.githubOwner,
				githubRepo: this.plugin.settings.githubRepo,
				githubBranch: this.plugin.settings.githubBranch,
				githubPath: this.plugin.settings.githubPath,
				aliyunEndpoint: this.plugin.settings.aliyunEndpoint,
				aliyunBucket: this.plugin.settings.aliyunBucket,
				aliyunAccessKeyId: this.plugin.settings.aliyunAccessKeyId,
				aliyunAccessKeySecret: this.plugin.settings.aliyunAccessKeySecret,
				tencentSecretId: this.plugin.settings.tencentSecretId,
				tencentSecretKey: this.plugin.settings.tencentSecretKey,
				tencentBucket: this.plugin.settings.tencentBucket,
				tencentRegion: this.plugin.settings.tencentRegion,
				smmsToken: this.plugin.settings.smmsToken,
			};

			const response = await fetch(url, {
				method: "PUT",
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(bedData, null, 2),
			});

			if (response.ok || response.status === 201 || response.status === 204) {
				new Notice("配置已上传到 WebDAV 服务器");
				this.updateSyncStatus(`上传成功 (${new Date().toLocaleTimeString()})`);
			} else {
				new Notice(`上传失败: HTTP ${response.status}`);
				this.updateSyncStatus(`上传失败: HTTP ${response.status}`);
			}
		} catch (e) {
			new Notice(`上传异常: ${e}`);
			this.updateSyncStatus(`上传异常: ${e}`);
		} finally {
			this.syncing = false;
			this.setButtonLoading(btn, false);
		}
	}

	private async syncFromRemote() {
		if (!this.plugin.settings.webdavEnable || !this.plugin.settings.webdavUrl) {
			new Notice("请先启用 WebDAV 并填写服务器地址");
			return;
		}

		try {
			const url = `${this.plugin.settings.webdavUrl}${this.plugin.settings.webdavRemotePath.replace(/^\//, "")}`;
			const auth = btoa(`${this.plugin.settings.webdavUsername}:${this.plugin.settings.webdavPassword}`);

			const response = await fetch(url, {
				headers: { Authorization: `Basic ${auth}` },
			});

			if (!response.ok) {
				new Notice(`下载失败: HTTP ${response.status}`);
				return;
			}

			const remoteData = await response.json();
			if (!remoteData || typeof remoteData !== "object") {
				new Notice("远程数据格式无效");
				return;
			}

			// 合并远程图床配置到本地
			const bedKeys = [
				"githubToken", "githubOwner", "githubRepo", "githubBranch", "githubPath",
				"aliyunEndpoint", "aliyunBucket", "aliyunAccessKeyId", "aliyunAccessKeySecret",
				"tencentSecretId", "tencentSecretKey", "tencentBucket", "tencentRegion",
				"smmsToken",
			];
			for (const k of bedKeys) {
				if (k in remoteData && typeof remoteData[k] === "string") {
					(this.plugin.settings as any)[k] = remoteData[k];
				}
			}

			await this.plugin.saveSettings();
			new Notice("已从 WebDAV 下载并应用配置");
			this.display(); // 刷新设置页
		} catch (e) {
			new Notice(`下载异常: ${e}`);
		}
	}

	/**
	 * #11 智能下载（带冲突检测）
	 */
	private async syncFromRemoteSmart(btn?: HTMLButtonElement) {
		if (this.syncing) return;

		this.syncing = true;
		this.setButtonLoading(btn, true);
		this.updateSyncStatus("正在检查远程配置...");

		try {
			const result = await this.plugin.syncFromRemoteWithConflict();

			if (!result) return; // 内部已弹过错误

			if (result.conflict) {
				const msg = result.remoteNewer
					? "远程配置比本地新，是否覆盖本地？"
					: "本地配置比远程新，是否用远程覆盖？";

				if (!confirm(`${result.error}\n\n${msg}`)) return;

				// 用户确认覆盖 → 强制执行旧版同步逻辑
				this.updateSyncStatus("正在合并...");
				await this.syncFromRemote();
				this.updateSyncStatus(`合并完成 (${new Date().toLocaleTimeString()})`);
				return;
			}

			if (result.success) {
				new Notice("已从 WebDAV 智能合并配置");
				this.updateSyncStatus(`同步成功 (${new Date().toLocaleTimeString()})`);
				this.display();
			} else {
				new Notice(result.error || "同步失败");
				this.updateSyncStatus(result.error || "同步失败");
			}
		} finally {
			this.syncing = false;
			this.setButtonLoading(btn, false);
		}
	}

	/** 更新同步状态文本 */
	private updateSyncStatus(text: string): void {
		if (this.webdavStatusEl) {
			this.webdavStatusEl.textContent = text;
		}
	}

	/** 设置按钮加载状态 */
	private setButtonLoading(btn: HTMLButtonElement | undefined, loading: boolean): void {
		if (!btn) return;
		btn.disabled = loading;
		if (loading) {
			btn.dataset.originalText = btn.textContent || "";
			btn.textContent = "处理中...";
		} else {
			btn.textContent = btn.dataset.originalText || btn.textContent;
			delete btn.dataset.originalText;
		}
	}

	// ========== 快捷筛选按钮 ==========

	private renderQuickFilterSettings(container: HTMLElement) {
		const collapsible = container.createDiv({ cls: "imagelmgr-collapsible" });

		const header = collapsible.createDiv({ cls: "imagelmgr-collapsible-header" });
		const titleRow = header.createDiv({ cls: "imagelmgr-collapsible-title-row" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-arrow", text: "▶" });
		titleRow.createSpan({ cls: "imagelmgr-collapsible-title", text: "快捷筛选" });
		header.createSpan({ cls: "imagelmgr-collapsible-subtitle", text: "自定义工具栏筛选按钮的显示、名称与图标" });

		const content = collapsible.createDiv({ cls: "imagelmgr-collapsible-content" });
		content.style.display = "none";

		const desc = content.createDiv({ text: "控制每个筛选按钮是否显示，以及按钮上的文字标签：", cls: "setting-item-description" });
		desc.style.marginBottom = "8px";

		/** 内置 key（不可删除） */
		const BUILTIN_KEYS = ["local", ImageBedType.GitHub, ImageBedType.Aliyun, ImageBedType.Tencent, ImageBedType.Other];

		for (let i = 0; i < this.plugin.settings.quickFilterButtons.length; i++) {
			this.renderFilterButtonRow(content, BUILTIN_KEYS, i);
		}

		// ========== 新增自定义图床 ==========
		content.createDiv({ cls: "imagelmgr-section-heading", text: "自定义筛选按钮" });
		const addArea = content.createDiv({ cls: "imagelmgr-add-area" });

		let domainInput: HTMLInputElement;
		let labelInput: HTMLInputElement;
		let addCustomSvgEl: HTMLTextAreaElement;

		new Setting(addArea)
			.setName("域名")
			.setDesc("例如 www.baidu.com 或 img.example.com")
			.addText((text) => {
				domainInput = text.inputEl;
				text.setPlaceholder("www.example.com");
			})
			.addButton((btn) => btn
				.setButtonText("添加")
				.onClick(async () => {
					let domain = domainInput.value.trim().toLowerCase();
					if (!domain) { new Notice("请输入域名"); domainInput.focus(); return; }
					domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
					if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
						new Notice(`"${domain}" 不是有效的域名格式`); domainInput.focus(); return;
					}
					if (this.plugin.settings.quickFilterButtons.some((b) => b.key === domain)) {
						new Notice(`域名 "${domain}" 已存在`); return;
					}
					const newBtn: QuickFilterConfig = {
						key: domain as any,
						label: labelInput.value.trim() || domain,
						enabled: true,
						icon: isValidSvg(addCustomSvgEl.value) ? addCustomSvgEl.value : undefined,
					};
					this.plugin.settings.quickFilterButtons.push(newBtn);
					domainInput.value = "";
					labelInput.value = "";
					addCustomSvgEl.value = "";
					await this.plugin.saveSettings();
					this.renderQuickFilterSettings(container);
					new Notice(`已添加: ${newBtn.label}`);
				}));

		new Setting(addArea)
			.setName("按钮名称")
			.setDesc("留空则自动使用域名作为名称")
			.addText((text) => {
				labelInput = text.inputEl;
				text.setPlaceholder("自定义名称");
			});

		new Setting(addArea)
			.setName("自定义图标")
			.setDesc("可选，粘贴 SVG 代码或留空使用默认图标")
			.addTextArea((text) => {
				addCustomSvgEl = text.inputEl;
				addCustomSvgEl.addClass("imagelmgr-custom-svg-input");
				text.setPlaceholder('粘贴自定义 SVG 代码');
			});

		// 折叠/展开事件
		const arrowEl = titleRow.querySelector(".imagelmgr-collapsible-arrow") as HTMLSpanElement;
		header.addEventListener("click", () => {
			const isOpen = content.style.display !== "none";
			content.style.display = isOpen ? "none" : "";
			if (arrowEl) arrowEl.textContent = isOpen ? "▶" : "▼";
		});
	}

	/** 渲染单个筛选按钮配置行 */
	private renderFilterButtonRow(content: HTMLElement, BUILTIN_KEYS: string[], idx: number) {
		const btnCfg = this.plugin.settings.quickFilterButtons[idx];
		const isCustom = !BUILTIN_KEYS.includes(btnCfg.key);
		const row = content.createDiv({ cls: "imagelmgr-quickfilter-row" });

		// 图标预览（左侧）
		this.updateRowIcon(row, btnCfg);

		const body = row.createDiv({ cls: "imagelmgr-qf-body" });
		let customSvgEl: HTMLTextAreaElement | null = null;

		if (isCustom) {
			// 自定义域名：显示名称（带删除按钮）+ SVG 文本框
			new Setting(body)
				.setName("名称")
				.setDesc("按钮显示的文字标签")
				.addText((text) => text
					.setPlaceholder("按钮名称")
					.setValue(btnCfg.label)
					.onChange(async (value) => {
						btnCfg.label = value;
						await this.plugin.saveSettings();
						this.updateRowIcon(row, btnCfg);
					}))
				.addButton((btn) => btn
					.setButtonText("×")
					.setTooltip("删除此图床")
					.onClick(async () => {
						this.plugin.settings.quickFilterButtons.splice(idx, 1);
						await this.plugin.saveSettings();
						this.renderQuickFilterSettings(content.parentElement!);
					}));

			new Setting(body)
				.setName("自定义图标")
				.setDesc("留空使用默认图标")
				.addTextArea((text) => {
					customSvgEl = text.inputEl;
					customSvgEl.addClass("imagelmgr-custom-svg-input");
					text.setPlaceholder('粘贴自定义 SVG 代码');
					text.setValue(isValidSvg(btnCfg.icon) ? btnCfg.icon! : "");
					text.onChange(async (value) => {
						btnCfg.icon = value || "";
						await this.plugin.saveSettings();
						this.updateRowIcon(row, btnCfg);
					});
				});
		} else {
			// 内置图床：只显示名称标签
			body.createEl("span", { cls: "imagelmgr-builtin-label", text: btnCfg.label });
		}

		// 右侧操作区：开关 + 删除
		const actions = row.createDiv({ cls: "imagelmgr-qf-actions" });

		new Setting(actions)
			.setName("")
			.setDesc("")
			.addToggle((toggle) => toggle
				.setValue(btnCfg.enabled)
				.onChange(async (value) => {
					btnCfg.enabled = value;
					await this.plugin.saveSettings();
				}));
	}

	/** 更新行左侧的图标预览 */
	private updateRowIcon(row: HTMLDivElement, cfg: QuickFilterConfig) {
		const svg = getFilterButtonIcon(cfg);
		const existingIcon = row.querySelector(".imagelmgr-bed-icon");
		if (existingIcon) existingIcon.innerHTML = svg;
		else row.insertAdjacentHTML("afterbegin", `<span class="imagelmgr-bed-icon">${svg}</span>`);
	}

	// ========== 图床折叠卡片 ==========

	private renderCollapsibleBed(container: HTMLElement, config: BedConfig) {
		const collapsible = container.createDiv({ cls: "imagelmgr-collapsible" });

		const header = collapsible.createDiv({ cls: "imagelmgr-collapsible-header" });
		const titleRow = header.createDiv({ cls: "imagelmgr-collapsible-title-row" });
		const arrow = titleRow.createSpan({ cls: "imagelmgr-collapsible-arrow", text: "▶" });

		// 图床图标
		const bedType = BED_NAME_TYPE_MAP[config.name];
		if (bedType) {
			const iconSpan = titleRow.createSpan({ cls: "imagelmgr-bed-icon" });
			iconSpan.innerHTML = getBedFaviconSvg(bedType);
		}

		titleRow.createSpan({ cls: "imagelmgr-collapsible-title", text: config.name });
		header.createSpan({ cls: "imagelmgr-collapsible-subtitle", text: config.desc });

		const content = collapsible.createDiv({ cls: "imagelmgr-collapsible-content" });
		content.style.display = "none";

		for (const field of config.fields) {
			new Setting(content)
				.setName(field.name)
				.setDesc(field.desc)
				.addText((text) => {
					if (field.isSecret) {
						text.inputEl.type = "password";
						text.inputEl.placeholder = field.placeholder;
						text.inputEl.value = (this.plugin.settings as any)[field.key];
						text.inputEl.addEventListener("input", () => {
							(this.plugin.settings as any)[field.key] = text.inputEl.value;
							debouncedSaveSettings(this.plugin);
						});
					} else {
						text
							.setPlaceholder(field.placeholder)
							.setValue((this.plugin.settings as any)[field.key])
							.onChange((value) => {
								(this.plugin.settings as any)[field.key] = value;
								debouncedSaveSettings(this.plugin);
							});
					}
					return text;
				});
		}

		content.createDiv({
			cls: "imagelmgr-setting-guide",
			text: config.guide,
		});

		header.addEventListener("click", () => {
			const isOpen = content.style.display !== "none";
			content.style.display = isOpen ? "none" : "";
			arrow.textContent = isOpen ? "▶" : "▼";
		});
	}
}
