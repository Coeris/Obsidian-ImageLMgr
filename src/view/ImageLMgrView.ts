/**
 * ImageLMgr 右侧面板视图
 * 单栏布局：本地图片（含云端状态）+ 云端未引用文件
 */

import { ItemView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import ImageLMgrPlugin from "../main";
import { ImageLink, ImageBedType, CloudFile, QuickFilterConfig } from "../types";
import { extractFileName } from "../comparator/CloudComparator";
import { parseFrontmatter } from "../utils/FrontmatterParser";
import { detectBedTypeFromUrl, getBedFaviconSvg, LOCAL_ICON_SVG, getFilterButtonIcon, BUILTIN_BED_TYPES } from "../icons";

export const VIEW_TYPE_IMAGE_LMGR = "imagelmgr";

/** 图片文件扩展名 */
const IMAGE_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif", "avif",
]);

/** 过滤模式 */

export class ImageLMgrView extends ItemView {
	private plugin: ImageLMgrPlugin;
	private localImages: ImageLink[] = [];
	private vaultImagesMap = new Map<string, ImageLink>();
	private cloudFiles: CloudFile[] = [];
	/** 当前选中的图床（用于上传/删除等操作，来自全局设置默认值） */
	private selectedBed: ImageBedType;
	/** 本地图片云端比对结果缓存（跨所有图床） */
	private compareResult = new Map<string, { exists: boolean; url?: string; bedType?: ImageBedType }>();

	/** 过滤状态 */
	private searchKeyword = "";
	/** 当前激活的筛选：null=显示全部, "local"=仅本地, 其他=对应图床/自定义域名 */
	private activeFilter: "local" | ImageBedType | (string & {}) | null = null;

	/** 文件名 → 引用次数映射 */
	private fileNameRefCount = new Map<string, number>();

	/** 动态图床筛选按钮容器 */
	private bedFilterGroupEl: HTMLDivElement | null = null;

	/** 操作区按钮引用（用于联动显隐） */
	private uploadBtn: HTMLButtonElement | null = null;
	private createDirBtn: HTMLButtonElement | null = null;

	/** 标签滑动窗口焦点：key=图片pure路径, value=当前居中的文件索引 */
	private tagFocusMap: Map<string, number> = new Map();

	/** 云端文件多选状态：存储选中文件的 prefix 或 name */
	private selectedCloudFiles = new Set<string>();

	/** 删除选中按钮引用（用于更新计数） */
	private deleteSelectedBtn: HTMLButtonElement | null = null;
	/** 全选复选框引用 */
	private selectAllCheckbox: HTMLInputElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ImageLMgrPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.selectedBed = ImageBedType.Aliyun;
	}

	getViewType(): string {
		return VIEW_TYPE_IMAGE_LMGR;
	}

	getDisplayText(): string {
		return "ImageLMgr";
	}

	getIcon(): string {
		return "cloud-check";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("imagelmgr-container");

		this.render(container);
		if (this.plugin.settings.autoRefreshOnOpen) {
			await this.refresh();
		}
	}

	async onClose() {
		// 清理数据引用，帮助 GC
		this.localImages = [];
		this.cloudFiles = [];
		this.compareResult.clear();
		this.vaultImagesMap.clear();
		this.fileNameRefCount.clear();
		// 清理 DOM
		this.containerEl.empty();
	}

	async refresh() {
		this.vaultImagesMap = await this.plugin.getVaultImages();
		this.localImages = Array.from(this.vaultImagesMap.values());
		// 按 Obsidian 默认字母序排序
		this.localImages.sort((a, b) => (a.resolvedPath || a.pure).localeCompare(b.resolvedPath || b.pure));
		this.fileNameRefCount = this.buildFileNameRefCount();

		// 跨所有已配置图床进行比对，合并结果
		const allCompareResult = new Map<string, { exists: boolean; url?: string; bedType?: ImageBedType }>();
		const allCloudFiles: CloudFile[] = [];

		for (const bedType of Object.values(ImageBedType)) {
			try {
				// 先获取云端文件列表（阿里云/腾讯云的比对依赖此数据）
				const cloudFiles = await this.plugin.listCloudFiles(bedType);
				for (const cf of cloudFiles) cf.bedType = bedType;
				allCloudFiles.push(...cloudFiles);

				// 用云端文件列表做比对（避免 CORS HEAD 请求）
				const compareResult = await this.plugin.compareLocalWithCloud(this.localImages, bedType, cloudFiles);
				// 合并比对结果：记录每条本地图片在哪个图床存在及对应URL
				for (const [key, val] of compareResult.entries()) {
					if (val.exists && !allCompareResult.has(key)) {
						allCompareResult.set(key, { ...val, bedType });
					}
				}
			} catch { /* 该图床未配置或请求失败，跳过 */ }
		}

		this.cloudFiles = allCloudFiles;
		this.compareResult = allCompareResult;

		// 更新动态图床筛选按钮
		this.renderFilterIcons();
		this.renderContent();
	}

	/**
	 * 获取已启用的快捷筛选按钮列表
	 */
	private getEnabledFilters(): QuickFilterConfig[] {
		return (this.plugin.settings.quickFilterButtons || []).filter((cfg) => cfg.enabled);
	}

	/** 内置图床类型集合（用于区分自定义域名） */
	private static readonly BUILTIN_BEDS = BUILTIN_BED_TYPES;


	private render(container: HTMLElement) {
		// ===== 过滤栏（最上面） =====
		const filterBar = container.createDiv({ cls: "imagelmgr-filter-bar" });

		const searchInput = filterBar.createEl("input", {
			type: "text",
			cls: "imagelmgr-search-input",
			attr: { placeholder: "搜索文件名..." },
		});
		searchInput.addEventListener("input", () => {
			this.searchKeyword = searchInput.value.trim().toLowerCase();
			this.renderContent();
		});

		// 图标筛选按钮组
		this.bedFilterGroupEl = filterBar.createDiv({ cls: "imagelmgr-filter-group imagelmgr-bed-filter-group" });
		this.renderFilterIcons();

		// 右侧操作区（靠右）
		const actionsRight = filterBar.createDiv({ cls: "imagelmgr-filter-actions" });

		this.createDirBtn = actionsRight.createEl("button");
		this.createDirBtn.textContent = "新建目录";
		this.createDirBtn.addEventListener("click", () => this.showCreateDirectoryDialog());

		this.uploadBtn = actionsRight.createEl("button", { text: "批量上传" });
		this.uploadBtn.addEventListener("click", () => this.batchUpload());

		const refreshBtn = actionsRight.createEl("button", { text: "🔄 刷新", cls: "imagelmgr-refresh-btn" });
		refreshBtn.addEventListener("click", async () => {
			refreshBtn.textContent = "⏳ 刷新中...";
			refreshBtn.disabled = true;
			refreshBtn.classList.add("loading");
			this.tagFocusMap.clear();

			const container2 = this.containerEl.querySelector(".imagelmgr-container") as HTMLElement | null;
			container2?.classList.add("refreshing");

			try {
				await new Promise(r => setTimeout(r, 200));
				await this.refresh();
			} catch (e) {
				new Notice(`刷新失败: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				container2?.classList.remove("refreshing");
				container2?.classList.add("refreshed");
				setTimeout(() => container2?.classList.remove("refreshed"), 300);

				refreshBtn.textContent = "🔄 刷新";
				refreshBtn.disabled = false;
				refreshBtn.classList.remove("loading");
			}
		});

		// 初始联动状态
		this.syncActionButtons();

		// 统一列表
		const list = container.createDiv({ cls: "imagelmgr-list", attr: { id: "imagelmgr-main-list" } });
		list.createDiv({ cls: "imagelmgr-loading", text: "加载中..." });
	}

	private renderContent() {
		const el = document.getElementById("imagelmgr-main-list");
		if (!el) return;

		// 保留新建目录输入栏（不被清空）
		const createdirBar = el.querySelector(".imagelmgr-createdir-bar");
		el.empty();
		if (createdirBar) el.prepend(createdirBar);

		// 过滤本地图片
		const filteredLocal = this.applyLocalFilter(this.localImages);

		if (this.localImages.length === 0 && this.cloudFiles.length === 0) {
			el.createDiv({ cls: "imagelmgr-empty", text: "无数据" });
			return;
		}

		// ===== 第一部分：本地图片（含云端状态） =====
		if (filteredLocal.length > 0) {
			for (const img of filteredLocal) {
				this.renderLocalItem(el, img);
			}
		}

		// ===== 第二部分：云端未引用文件 =====
		const cloudOnly = this.getCloudOnlyFiles();
		const filteredCloud = this.applyCloudFilter(cloudOnly);

		if (this.plugin.settings.showUnreferenced && filteredCloud.length > 0) {
			// 分隔线
			el.createDiv({ cls: "imagelmgr-divider" });

			const cloudHeader = el.createDiv({ cls: "imagelmgr-part-header" });
			const cloudIcon = cloudHeader.createSpan({ cls: "imagelmgr-part-icon" });
			cloudIcon.innerHTML = `<svg viewBox="0 0 1024 1024" width="14" height="14"><path fill="#5C7CFA" d="M811.2 456.8c-19.6-118.4-124-208.8-247.2-208.8-108 0-201.6 70-233.6 168.4C196 430 88 544 88 681.6c0 142 114.8 256.8 256 256.8h440c116 0 210-94 210-209.6 0-110-84.8-200.8-192.8-212z"/></svg>`;
			cloudHeader.createSpan({ text: "云端未引用文件", cls: "imagelmgr-part-title" });
			cloudHeader.createSpan({
				text: `${filteredCloud.length} 个`,
				cls: "imagelmgr-part-count",
			});

			// 多选操作栏
			const cleanupBar = el.createDiv({ cls: "imagelmgr-cleanup-bar" });

			// 全选复选框
			const selectAllLabel = cleanupBar.createEl("label", { cls: "imagelmgr-select-all-label" });
			this.selectAllCheckbox = selectAllLabel.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			selectAllLabel.createSpan({ text: "全选" });

			this.selectAllCheckbox.addEventListener("change", () => {
				const checked = this.selectAllCheckbox!.checked;
				if (checked) {
					filteredCloud.forEach(f => this.selectedCloudFiles.add(f.prefix || f.name));
				} else {
					this.selectedCloudFiles.clear();
				}
				// 更新所有复选框状态
				el.querySelectorAll<HTMLInputElement>(".imagelmgr-cloud-checkbox").forEach((cb: HTMLInputElement) => {
					cb.checked = checked;
				});
				this.updateDeleteSelectedBtn();
			});

			cleanupBar.createSpan({ text: "这些文件没有被任何笔记引用", cls: "imagelmgr-cleanup-info" });

			// 删除选中按钮
			this.deleteSelectedBtn = cleanupBar.createEl("button", {
				text: "删除选中",
				cls: "imagelmgr-btn-sm imagelmgr-btn-danger",
			});
			this.deleteSelectedBtn.disabled = true;
			this.deleteSelectedBtn.addEventListener("click", () => {
				const selected = filteredCloud.filter(f => this.selectedCloudFiles.has(f.prefix || f.name));
				if (selected.length > 0) {
					this.cleanupUnreferenced(selected);
				}
			});

			// 按文件夹分组渲染
			this.renderCloudGroupedByFolder(el, filteredCloud);
		}

		// 两个列表都为空
		if (filteredLocal.length === 0 && filteredCloud.length === 0) {
			el.createDiv({ cls: "imagelmgr-empty", text: "无匹配结果" });
		}
	}

	// ==================== 本地图片项 ====================

	private renderLocalItem(container: HTMLElement, img: ImageLink) {
		const result = this.compareResult.get(img.pure);
		const isUploaded = result?.exists;
		const item = container.createDiv({ cls: "imagelmgr-item" });

		// 类型图标（无背景、无文字）
		const iconSpan = item.createSpan({ cls: "imagelmgr-bed-icon" });
		if (img.type === "local") {
			iconSpan.innerHTML = LOCAL_ICON_SVG;
		} else {
			const bedType = detectBedTypeFromUrl(img.pure);
		iconSpan.innerHTML = getBedFaviconSvg(bedType);
		}

		// 文件名（完整显示，根目录用"根目录"标识）
		const displayPath = img.resolvedPath || img.pure;
		const parts = displayPath.split("/");
		let shortPath: string;
		if (parts.length <= 1) {
			// 根目录文件
			shortPath = `根目录/${displayPath}`;
		} else {
			// 子目录文件：直接显示完整路径
			shortPath = displayPath;
		}
		const pathSpan = item.createSpan({ cls: "imagelmgr-path", text: shortPath, title: "双击复制图片路径" });
		pathSpan.classList.add("clickable");

		// 双击路径 → 复制图片路径
		pathSpan.addEventListener("dblclick", () => this.copyImagePath(img));

		// 来源文件：滑动窗口模式，最多显示3个标签，点击后居中
		const WINDOW_SIZE = 3;
		if (img.files.length > 0) {
			// 获取或初始化焦点索引（默认居中）
			let focusIdx = this.tagFocusMap.get(img.pure) ?? Math.min(1, img.files.length - 1);
			focusIdx = Math.max(0, Math.min(focusIdx, img.files.length - 1));

			const half = Math.floor(WINDOW_SIZE / 2);
			let start = focusIdx - half;
			let end = start + WINDOW_SIZE;

			// 边界修正：靠左/靠右时窗口不移出范围
			if (start < 0) { start = 0; end = WINDOW_SIZE; }
			if (end > img.files.length) { end = img.files.length; start = Math.max(0, end - WINDOW_SIZE); }

			const leftMore = start;                    // 左边隐藏数
			const rightMore = img.files.length - end;   // 右边隐藏数

			// 左侧 +N（0不显示）
			if (leftMore > 0) {
				const leftTag = item.createSpan({ cls: "imagelmgr-file-tag imagelmgr-file-tag-more", text: `+${leftMore}` });
				leftTag.classList.add("clickable");
				leftTag.addEventListener("click", () => {
					this.tagFocusMap.set(img.pure, start - 1);
					this.renderContent();
				});
			}

			// 窗口内的标签
			for (let i = start; i < end; i++) {
				const f = img.files[i];
				const isFocus = (i === focusIdx);
				const tag = item.createSpan({
					cls: `imagelmgr-file-tag${isFocus ? " imagelmgr-file-tag-focus" : ""}`,
					text: f,
				});
				tag.title = `双击跳转到 ${f}`;
				tag.classList.add("clickable");
				tag.addEventListener("click", () => {
					this.tagFocusMap.set(img.pure, i);
					this.renderContent();
				});
				tag.addEventListener("dblclick", () => this.jumpToFile(img, f));
			}

			// 右侧 +N
			if (rightMore > 0) {
				const rightTag = item.createSpan({ cls: "imagelmgr-file-tag imagelmgr-file-tag-more", text: `+${rightMore}` });
				rightTag.classList.add("clickable");
				rightTag.addEventListener("click", () => {
					this.tagFocusMap.set(img.pure, end);
					this.renderContent();
				});
			}
		}

		// 云端状态
		if (isUploaded) {
			item.createSpan({ cls: "imagelmgr-status imagelmgr-status-ok", text: "已上传" });
			// 根据云端链接域名显示对应图床图标（内联 SVG）
			const bedType = result.url ? detectBedTypeFromUrl(result.url) : null;
			if (bedType) {
				const svg = item.createEl("span", { cls: "imagelmgr-bed-icon", title: bedType });
				svg.innerHTML = getBedFaviconSvg(bedType);
			}
			if (result.url) {
				const link = item.createEl("a", {
					cls: "imagelmgr-link",
					text: "复制链接",
					href: result.url,
					title: result.url,
				});
				link.addEventListener("click", (e) => {
					e.preventDefault();
					navigator.clipboard.writeText(result.url!).then(
						() => new Notice("云端链接已复制"),
						() => new Notice("复制失败")
					);
				});
			}
		} else {
			item.createSpan({ cls: "imagelmgr-status imagelmgr-status-no", text: "未上传" });
			if (img.type === "local") {
				const uploadBtn = item.createEl("button", { text: "上传", cls: "imagelmgr-btn-sm" });
				uploadBtn.addEventListener("click", () => this.uploadSingleImage(img));
			}
		}
	}

	// ==================== 云端文件项 ====================

	private renderCloudItem(container: HTMLElement, file: CloudFile, indent: string = "") {
		const item = container.createDiv({ cls: "imagelmgr-item" });
		const fileKey = file.prefix || file.name;

		// 多选复选框
		const checkbox = item.createEl("input", {
			type: "checkbox",
			cls: "imagelmgr-cloud-checkbox",
		}) as HTMLInputElement;
		checkbox.checked = this.selectedCloudFiles.has(fileKey);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) {
				this.selectedCloudFiles.add(fileKey);
			} else {
				this.selectedCloudFiles.delete(fileKey);
			}
			this.updateSelectAllState();
			this.updateDeleteSelectedBtn();
		});

		// 根据云端链接域名显示对应图床图标（内联 SVG）
		const cloudBedType = detectBedTypeFromUrl(file.url);
		if (cloudBedType) {
			const svg = item.createEl("span", { cls: "imagelmgr-bed-icon", title: cloudBedType });
			svg.innerHTML = getBedFaviconSvg(cloudBedType);
		}

		const ext = this.getFileExtension(file.name);
		const isImage = IMAGE_EXTENSIONS.has(ext);

		if (isImage) {
			const thumb = item.createEl("img", {
				cls: "imagelmgr-thumb",
				attr: { src: file.url, loading: "lazy" },
			});
			thumb.addEventListener("error", () => { thumb.style.display = "none"; });
		} else {
			item.createSpan({ cls: "imagelmgr-cloud-file-icon", text: "📄" });
		}

		item.createSpan({ cls: "imagelmgr-path", text: `${indent}${file.prefix || file.name}` });

		const actions = item.createDiv({ cls: "imagelmgr-actions" });

		const copyBtn = actions.createEl("button", { text: "复制", cls: "imagelmgr-btn-sm" });
		copyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(file.url).then(
				() => new Notice("链接已复制"),
				() => new Notice("复制失败")
			);
		});

		const insertBtn = actions.createEl("button", { text: "插入", cls: "imagelmgr-btn-sm" });
		insertBtn.addEventListener("click", () => this.insertUrl(file.url));

		const deleteBtn = actions.createEl("button", { text: "删除", cls: "imagelmgr-btn-sm imagelmgr-btn-danger" });
		deleteBtn.addEventListener("click", () => { if (cloudBedType) this.deleteCloudFile(file.prefix || file.name, cloudBedType); });
	}

	private renderCloudWithDirectories(el: HTMLElement, files: CloudFile[]) {
		const directories: CloudFile[] = [];
		const rootFiles: CloudFile[] = [];

		for (const file of files) {
			if (file.isDirectory) {
				directories.push(file);
			} else {
				if (!(file.prefix || "").includes("/")) {
					rootFiles.push(file);
				}
			}
		}

		for (const file of rootFiles) {
			this.renderCloudItem(el, file);
		}

		directories.sort((a, b) => a.name.localeCompare(b.name));

		for (const dir of directories) {
			const dirPrefix = dir.prefix || dir.name;
			const dirFiles = files.filter(
				(f) => !f.isDirectory && (f.prefix || "").startsWith(dirPrefix)
			);
			if (dirFiles.length === 0) continue;

			const dirHeader = el.createDiv({ cls: "imagelmgr-dir-header" });
			const arrow = dirHeader.createSpan({ cls: "imagelmgr-dir-arrow", text: "▼" });

			// 目录全选复选框
			const dirCheckbox = dirHeader.createEl("input", {
				type: "checkbox",
				cls: "imagelmgr-cloud-checkbox",
			}) as HTMLInputElement;
			const allSelected = dirFiles.every(f => this.selectedCloudFiles.has(f.prefix || f.name));
			dirCheckbox.checked = allSelected && dirFiles.length > 0;
			dirCheckbox.addEventListener("click", (e) => e.stopPropagation());
			dirCheckbox.addEventListener("change", () => {
				for (const f of dirFiles) {
					const key = f.prefix || f.name;
					if (dirCheckbox.checked) {
						this.selectedCloudFiles.add(key);
					} else {
						this.selectedCloudFiles.delete(key);
					}
				}
				// 更新目录内所有文件的复选框
				dirContent.querySelectorAll<HTMLInputElement>(".imagelmgr-cloud-checkbox").forEach(cb => {
					cb.checked = dirCheckbox.checked;
				});
				this.updateSelectAllState();
				this.updateDeleteSelectedBtn();
			});

			dirHeader.createSpan({ cls: "imagelmgr-dir-icon", text: "📁" });
			dirHeader.createSpan({ cls: "imagelmgr-dir-name", text: dir.name });
			dirHeader.createSpan({ cls: "imagelmgr-dir-count", text: `(${dirFiles.length})` });

			const dirContent = el.createDiv({ cls: "imagelmgr-dir-content" });

			dirHeader.addEventListener("click", () => {
				const isCollapsed = dirContent.style.display === "none";
				dirContent.style.display = isCollapsed ? "" : "none";
				arrow.textContent = isCollapsed ? "▼" : "▶";
			});

			for (const file of dirFiles) {
				this.renderCloudItem(dirContent, file, "  ");
			}
		}
	}

	/** 按文件夹路径分组渲染云端文件（嵌套树） */
	private renderCloudGroupedByFolder(el: HTMLElement, files: CloudFile[]) {
		interface TreeNode {
			files: CloudFile[];
			children: Map<string, TreeNode>;
		}

		// 构建树
		const root: TreeNode = { files: [], children: new Map() };

		for (const file of files) {
			const prefix = file.prefix || file.name;
			const parts = prefix.split("/");
			let node = root;

			// 最后一段是文件名，中间的都是目录
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				if (!node.children.has(part)) {
					node.children.set(part, { files: [], children: new Map() });
				}
				node = node.children.get(part)!;
			}
			node.files.push(file);
		}

		// 递归渲染
		this.renderTreeNode(el, root, 0);
	}

	/** 收集节点及其所有子节点的文件 */
	private collectAllFiles(node: { files: CloudFile[]; children: Map<string, { files: CloudFile[]; children: Map<string, any> }> }): CloudFile[] {
		const result = [...node.files];
		for (const child of node.children.values()) {
			result.push(...this.collectAllFiles(child));
		}
		return result;
	}

	/** 递归渲染树节点 */
	private renderTreeNode(
		container: HTMLElement,
		node: { files: CloudFile[]; children: Map<string, { files: CloudFile[]; children: Map<string, any> }> },
		depth: number,
	) {
		// 渲染当前层级的文件
		for (const file of node.files) {
			this.renderCloudItem(container, file);
		}

		// 渲染子目录
		const sortedChildren = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0]));

		for (const [dirName, childNode] of sortedChildren) {
			const allFiles = this.collectAllFiles(childNode);

			const dirHeader = container.createDiv({ cls: "imagelmgr-dir-header" });
			dirHeader.style.paddingLeft = `${10 + depth * 16}px`;

			const arrow = dirHeader.createSpan({ cls: "imagelmgr-dir-arrow", text: "▶" });

			// 目录全选复选框
			const dirCheckbox = dirHeader.createEl("input", {
				type: "checkbox",
				cls: "imagelmgr-cloud-checkbox",
			}) as HTMLInputElement;
			const allSelected = allFiles.every(f => this.selectedCloudFiles.has(f.prefix || f.name));
			dirCheckbox.checked = allSelected && allFiles.length > 0;
			dirCheckbox.addEventListener("click", (e) => e.stopPropagation());
			dirCheckbox.addEventListener("change", () => {
				for (const f of allFiles) {
					const key = f.prefix || f.name;
					if (dirCheckbox.checked) {
						this.selectedCloudFiles.add(key);
					} else {
						this.selectedCloudFiles.delete(key);
					}
				}
				dirContent.querySelectorAll<HTMLInputElement>(".imagelmgr-cloud-checkbox").forEach((cb: HTMLInputElement) => {
					cb.checked = dirCheckbox.checked;
				});
				this.updateSelectAllState();
				this.updateDeleteSelectedBtn();
			});

			// 文件夹图标 SVG
			const iconSpan = dirHeader.createSpan({ cls: "imagelmgr-dir-icon" });
			iconSpan.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

			dirHeader.createSpan({ cls: "imagelmgr-dir-name", text: dirName });
			dirHeader.createSpan({ cls: "imagelmgr-dir-count", text: `(${allFiles.length})` });

			const dirContent = container.createDiv({ cls: "imagelmgr-dir-content" });
			dirContent.style.display = "none"; // 默认折叠

			dirHeader.addEventListener("click", () => {
				const isCollapsed = dirContent.style.display === "none";
				dirContent.style.display = isCollapsed ? "" : "none";
				arrow.textContent = isCollapsed ? "▼" : "▶";
			});

			// 递归渲染子节点
			this.renderTreeNode(dirContent, childNode, depth + 1);
		}
	}

	// ==================== 动态图床筛选按钮 ====================

	/**
	 * 渲染图床筛选按钮（根据本地检测到的图床动态生成）
	 */
	/**
	 * 渲染图标筛选按钮：本地图标 + 检测到的图床图标
	 * 点击选中筛选，再次点击取消（显示全部）
	 */
	private renderFilterIcons() {
		if (!this.bedFilterGroupEl) return;
		this.bedFilterGroupEl.empty();

		const filters = this.getEnabledFilters();
		for (const cfg of filters) {
			const btn = this.bedFilterGroupEl.createEl("button", {
				cls: `imagelmgr-bed-filter-btn ${this.activeFilter === cfg.key ? "active" : ""}`,
				attr: { "data-filter": cfg.key },
			});

			const iconSpan = btn.createEl("span", { cls: "imagelmgr-bed-icon" });
			iconSpan.innerHTML = getFilterButtonIcon(cfg);
			btn.createSpan({ text: cfg.label });

			btn.addEventListener("click", () => {
				if (this.activeFilter === cfg.key) {
					this.activeFilter = null;
				} else {
					this.activeFilter = cfg.key;
				}
				this.renderFilterIcons();
				this.renderContent();
			});
		}
		this.syncActionButtons();
	}

	// ==================== 过滤逻辑 ====================

	/**
	 * 根据当前筛选状态联动操作按钮显隐
	 * - "本地"筛选：隐藏批量上传、新建目录
	 * - 已知不支持创建目录的图床（GitHub、Other）：隐藏新建目录
	 * - 自定义域名 / 其他新增图床：默认显示（动态检测是否已配置）
	 * - 全部/阿里云/腾讯云：显示全部
	 */
	private syncActionButtons() {
		if (this.uploadBtn) {
			const canUpload = this.activeFilter !== "local";
			this.uploadBtn.style.display = canUpload ? "" : "none";
		}
		if (this.createDirBtn) {
			this.createDirBtn.style.display = this.canCreateDirectory(this.activeFilter) ? "" : "none";
		}
	}

	/**
	 * 动态判断当前筛选是否支持创建目录
	 * 白名单机制：已知不支持的只有 local / GitHub / Other，
	 * 其余（阿里云、腾讯云、自定义域名、未来新增图床）默认显示
	 */
	private canCreateDirectory(filter: string | null): boolean {
		if (!filter || filter === "local") return false;
		if (filter === ImageBedType.GitHub || filter === ImageBedType.Other) return false;
		return true;
	}

	/** 获取已注册的自定义域名列表（用于从其他图床中排除） */
	private getCustomDomains(): string[] {
		return this.getEnabledFilters()
			.filter((cfg) => cfg.key !== "local" && !ImageLMgrView.BUILTIN_BEDS.has(cfg.key as ImageBedType))
			.map((cfg) => cfg.key);
	}

	/** 检查 URL 是否属于已注册的自定义域名 */
	private isCustomDomainMatch(url: string): boolean {
		try {
			const hostname = new URL(url).hostname;
			return this.getCustomDomains().some((domain) => hostname.includes(domain));
		} catch { return false; }
	}

	private applyLocalFilter(images: ImageLink[]): ImageLink[] {
		let result = images;

		if (this.searchKeyword) {
			result = result.filter(
				(img) => img.pure.toLowerCase().includes(this.searchKeyword) ||
					img.files.some((f) => f.toLowerCase().includes(this.searchKeyword))
			);
		}

	// 统一筛选逻辑（基于 activeFilter）
		if (this.activeFilter === "local") {
			result = result.filter((img) => img.type === "local");
		} else if (this.activeFilter === ImageBedType.Other) {
			// 其他图床：显示非内置图床 且 非已注册自定义域名的图片
			result = result.filter((img) => {
				if (img.type === "local") return false;
				const bedType = detectBedTypeFromUrl(img.pure);
				if (bedType && ImageLMgrView.BUILTIN_BEDS.has(bedType) && bedType !== ImageBedType.Other) return false;
				return !this.isCustomDomainMatch(img.pure);
			});
		} else if (this.activeFilter !== null && ImageLMgrView.BUILTIN_BEDS.has(this.activeFilter as ImageBedType)) {
			// 内置图床类型
			const targetBed = this.activeFilter as ImageBedType;
			result = result.filter((img) => {
				if (img.type === "local") return false;
				const imgBedType = detectBedTypeFromUrl(img.pure);
				return imgBedType === targetBed
					|| (this.compareResult.get(img.pure)?.bedType === targetBed);
			});
		} else if (this.activeFilter !== null) {
			// 自定义域名：检查 URL 是否包含该域名
			const domainKey = this.activeFilter as string;
			result = result.filter((img) => {
				if (img.type === "local") return false;
				try { return new URL(img.pure).hostname.includes(domainKey); } catch { return false; }
			});
		}

		return result;
	}

	// ==================== 跳转功能 ====================

	// ==================== 跳转 & 复制功能 ====================

	/**
	 * 双击路径 → 复制图片路径（或文件名，可设置）
	 */
	private copyImagePath(img: ImageLink) {
		const displayPath = img.resolvedPath || img.pure;
		const copyTarget = displayPath; // 后续可通过设置改为只取 fileName

		navigator.clipboard.writeText(copyTarget).then(() => {
			new Notice(`已复制: ${copyTarget}`);
		}).catch(() => {
			new Notice("复制失败");
		});
	}

	/**
	 * 打开指定笔记并跳转到此图片的引用位置
	 */
	private async jumpToFile(img: ImageLink, filePath: string) {
		const abstractFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!abstractFile || !(abstractFile instanceof TFile)) return;

		try {
			const leaf = this.plugin.app.workspace.getLeaf(false);
			await leaf.openFile(abstractFile, { active: true });

			// 尝试在编辑器中定位到图片
			const editorView = this.plugin.app.workspace.activeEditor;
			if (editorView?.editor) {
				const content = editorView.editor.getValue();
				let searchStr: string;
				if (img.type === "local") {
					searchStr = img.raw || img.pure;
				} else {
					searchStr = img.pure;
				}
				const pos = content.indexOf(searchStr);
				if (pos !== -1) {
					const { line } = editorView.editor.offsetToPos(pos);
					editorView.editor.setCursor({ line: line, ch: 0 });
					editorView.editor.scrollIntoView({ from: { line: Math.max(0, line - 3), ch: 0 }, to: { line: line + 5, ch: 0 } }, true);
				}
			}
		} catch (e) {
			new Notice(`无法打开文件: ${filePath}`);
		}
	}

	/**
	 * 获取云端未引用的文件（不被任何本地笔记引用的）
	 */
	private getCloudOnlyFiles(): CloudFile[] {
		return this.cloudFiles.filter(
			(f) => !f.isDirectory && (this.fileNameRefCount.get(extractFileName(f.name) || f.name) || 0) === 0
		);
	}

	private applyCloudFilter(files: CloudFile[]): CloudFile[] {
		let result = files;

		if (this.searchKeyword) {
			result = result.filter(
				(f) => f.name.toLowerCase().includes(this.searchKeyword) ||
					(f.prefix || "").toLowerCase().includes(this.searchKeyword)
			);
		}

		// 图床筛选
		if (this.activeFilter !== null && this.activeFilter !== "local") {
			const filterKey = this.activeFilter;
			result = result.filter((f) => {
			if (filterKey === ImageBedType.Other) {
				// 其他图床：排除内置图床 + 已注册自定义域名
					const bedType = detectBedTypeFromUrl(f.url);
					if (bedType && ImageLMgrView.BUILTIN_BEDS.has(bedType) && bedType !== ImageBedType.Other) return false;
					return !this.isCustomDomainMatch(f.url);
				} else if (ImageLMgrView.BUILTIN_BEDS.has(filterKey as ImageBedType)) {
					return detectBedTypeFromUrl(f.url) === filterKey;
				}
				// 自定义域名匹配
				try { return new URL(f.url).hostname.includes(filterKey as string); } catch { return false; }
			});
		}

		return result;
	}

	// ==================== 创建目录 ====================

	private showCreateDirectoryDialog() {
		const el = document.getElementById("imagelmgr-main-list");
		if (!el) return;

		const existing = el.querySelector(".imagelmgr-createdir-bar");
		if (existing) { existing.remove(); return; }

		const bar = el.createDiv({ cls: "imagelmgr-createdir-bar" });
		el.prepend(bar);
		bar.createSpan({ text: "图床:" });

		const bedSelect = bar.createEl("select", { cls: "imagelmgr-bed-select imagelmgr-createdir-bed" });
		const supportedBeds: ImageBedType[] = [];
		for (const type of Object.values(ImageBedType)) {
			if (!this.canCreateDirectory(type)) continue;
			supportedBeds.push(type);
			bedSelect.createEl("option", { value: type, text: type });
		}
		if (supportedBeds.length === 0) {
			bar.createSpan({ text: "当前无支持的图床（仅阿里云 OSS / 腾讯云 COS 支持创建目录）", cls: "imagelmgr-empty" });
			return;
		}

		bedSelect.value = supportedBeds.includes(this.selectedBed)
			? this.selectedBed
			: supportedBeds[0];

		// 选择图床时同步筛选列表
		bedSelect.addEventListener("change", () => {
			this.activeFilter = bedSelect.value as ImageBedType;
			this.renderFilterIcons();
			this.renderContent();
		});

		// 打开时自动选中当前下拉框对应的图床
		this.activeFilter = bedSelect.value as ImageBedType;
		this.renderFilterIcons();
		this.renderContent();

		bar.createSpan({ text: "  路径:" });
		const input = bar.createEl("input", {
			type: "text",
			cls: "imagelmgr-createdir-input",
			attr: { placeholder: '例如: blog/2026 或 images' },
		});

		// 回车触发创建
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") confirmBtn.click();
		});

		const confirmBtn = bar.createEl("button", { text: "创建", cls: "mod-cta imagelmgr-btn-sm" });
		confirmBtn.addEventListener("click", async () => {
			const dirPath = input.value.trim().replace(/\/+$/, "");
			if (!dirPath) { new Notice("请输入目录路径"); input.focus(); return; }

			// 基础校验：不允许以 / 开头、不允许连续斜杠、非法字符
			if (/^[/\\]/.test(dirPath)) {
				new Notice("路径不能以 / 开头"); input.focus(); return;
			}
			if (/[<>:"|?*\x00-\x1f]/.test(dirPath)) {
				new Notice("路径包含非法字符（< > : \" | ? * 等）"); input.focus(); return;
			}
			if (dirPath.includes("..")) {
				new Notice("路径不能包含 .."); input.focus(); return;
			}

			const targetBed = bedSelect.value as ImageBedType;
			if (!confirm(`确定要在 [${targetBed}] 创建目录 "${dirPath}" 吗？`)) return;

			new Notice(`正在 ${targetBed} 创建目录 ${dirPath}...`);
			const result = await this.plugin.createCloudDirectory(dirPath, targetBed);
			if (result.success) {
				new Notice(`目录 ${dirPath} 创建成功`);
				bar.remove();
				await this.refresh();
			} else {
				new Notice(`创建失败: ${result.error}`);
			}
		});

		const cancelBtn = bar.createEl("button", { text: "取消", cls: "imagelmgr-btn-sm" });
		cancelBtn.addEventListener("click", () => bar.remove());
		input.focus();
	}

	// ==================== 未引用清理 ====================

	private async cleanupUnreferenced(files: CloudFile[]) {
		const count = files.length;
		if (!confirm(`确定要删除选中的 ${count} 个文件吗？此操作不可撤销。`)) return;

		let success = 0;
		let failed = 0;
		for (const file of files) {
			const bedType = file.bedType || this.selectedBed;
			const result = await this.plugin.deleteCloudFile(file.prefix || file.name, bedType);
			if (result.success) success++; else failed++;
		}

		this.selectedCloudFiles.clear();
		new Notice(`删除完成：成功 ${success} 个，失败 ${failed} 个`);
		await this.refresh();
	}

	/** 更新全选复选框状态（根据子项选中情况） */
	private updateSelectAllState() {
		if (!this.selectAllCheckbox) return;
		const cloudCheckboxes = this.containerEl.querySelectorAll<HTMLInputElement>(".imagelmgr-item .imagelmgr-cloud-checkbox");
		if (cloudCheckboxes.length === 0) return;
		const allChecked = Array.from(cloudCheckboxes).every(cb => cb.checked);
		this.selectAllCheckbox.checked = allChecked;
	}

	/** 更新删除选中按钮的计数和禁用状态 */
	private updateDeleteSelectedBtn() {
		if (!this.deleteSelectedBtn) return;
		const count = this.selectedCloudFiles.size;
		this.deleteSelectedBtn.textContent = count > 0 ? `删除选中 (${count})` : "删除选中";
		this.deleteSelectedBtn.disabled = count === 0;
	}

	// ==================== 上传相关 ====================

	/**
	 * #10 获取当前文件生效的图床类型
	 * 优先级：Frontmatter > 面板选择 > 全局默认
	 */
	private async getEffectiveBedType(): Promise<ImageBedType> {
		// 先检查当前文件的 Frontmatter
		const fm = await this.plugin.getFileFrontmatter();
		if (fm.imageBed) {
			const bedName = String(fm.imageBed);
			for (const type of Object.values(ImageBedType)) {
				if (type === bedName) return type as ImageBedType;
			}
		}
		return this.selectedBed;
	}

	/**
	 * #5 + #10 带去重的单图上传
	 */
	private async uploadSingleImage(img: ImageLink) {
		if (img.type !== "local") { new Notice("仅支持上传本地图片"); return; }

		// #10 检查该文件的 auto-upload frontmatter
		const fm = await this.plugin.getFileFrontmatter();
		if (fm.autoUpload === false) {
			new Notice("该笔记的 Frontmatter 已禁用自动上传 (auto-upload: false)");
			return;
		}

		const resolvedPath = img.resolvedPath || img.pure;
		const fileName = extractFileName(resolvedPath);
		if (!fileName) { new Notice("无法解析文件名"); return; }

		// 优先用解析后的库内绝对路径查找文件
		let targetFile: TFile | null = this.app.vault.getAbstractFileByPath(resolvedPath) as TFile | null;
		if (!targetFile || !("extension" in targetFile)) {
			targetFile = this.app.vault.getFiles().find((f) => f.name === fileName) ?? null;
		}

		if (!targetFile || !("extension" in targetFile)) {
			new Notice(`未找到文件: ${fileName}`);
			return;
		}

		try {
			const content = await this.app.vault.readBinary(targetFile);
			const blob = new Blob([content]);
			const file = new File([blob], fileName);

			// #10 使用生效图床类型和路径
			const effectiveBed = await this.getEffectiveBedType();
			const effectivePath = typeof fm.imagePath === "string" ? fm.imagePath : undefined;

			new Notice(`正在上传 ${fileName}...`);

			// #5 使用带去重的上传
			const result = await this.plugin.uploadImageWithDedup(file, effectiveBed, effectivePath);

			if (!result.success) {
				new Notice(`上传失败: ${result.error}`);
				return;
			}

			if (result.cached) {
				new Notice(`图片已存在于云端（去重命中），直接替换链接`);
			} else {
				new Notice("上传成功，正在替换链接...");
			}

			await this.plugin.replaceLink(img, result.url!);
			new Notice("替换完成");
			this.compareResult = await this.plugin.compareLocalWithCloud(this.localImages, effectiveBed);
			this.renderContent();
		} catch (e) {
			new Notice(`上传异常: ${e}`);
		}
	}

	private async batchUpload() {
		if (this.localImages.length === 0) { new Notice("无本地图片可上传"); return; }

		const localOnly = this.localImages.filter((img) => img.type === "local");
		if (localOnly.length === 0) { new Notice("无本地图片可上传"); return; }

		const toUpload = localOnly.filter((img) => !this.compareResult.get(img.pure)?.exists);
		if (toUpload.length === 0) { new Notice("所有图片已上传"); return; }

		if (!confirm(`确定要上传 ${toUpload.length} 张本地图片吗？（重复图片会自动跳过）`)) return;

		const effectiveBed = await this.getEffectiveBedType();

		let successCount = 0;
		let dedupCount = 0;
		let failCount = 0;
		new Notice(`开始批量上传 ${toUpload.length} 张图片...`);
		for (let i = 0; i < toUpload.length; i++) {
			const img = toUpload[i];

			// #10 检查每张图的来源文件是否有 auto-upload 限制，并获取 imagePath
			let effectivePath: string | undefined;
			const sourceFile = img.files[0];
			if (sourceFile) {
				try {
					const sf = this.app.vault.getAbstractFileByPath(sourceFile);
					if (sf && "read" in sf) {
						const fc = await this.app.vault.read(sf as any);
						const fm = parseFrontmatter(fc);
						if (fm?.autoUpload === false) {
							continue; // 跳过禁用的文件
						}
						if (fm?.imagePath) effectivePath = fm.imagePath;
					}
				} catch { /* 解析失败不阻止 */ }
			}

			new Notice(`[${i + 1}/${toUpload.length}] ${img.pure}`);
			try {
				const resolvedPath = img.resolvedPath || img.pure;
				const fileName = extractFileName(resolvedPath);
				if (!fileName) continue;

				let targetFile: TFile | null = this.app.vault.getAbstractFileByPath(resolvedPath) as TFile | null;
				if (!targetFile || !("extension" in targetFile)) {
					targetFile = this.app.vault.getFiles().find((f) => f.name === fileName) ?? null;
				}
				if (!targetFile || !("extension" in targetFile)) continue;

				const content = await this.app.vault.readBinary(targetFile);
				const blob = new Blob([content]);
				const file = new File([blob], fileName);

				// #5 使用带去重的上传
				const result = await this.plugin.uploadImageWithDedup(file, effectiveBed, effectivePath);

				if (result.success && result.url) {
					if (result.cached) {
						dedupCount++;
					} else {
						successCount++;
					}
					await this.plugin.replaceLink(img, result.url);
				} else {
					failCount++;
				}
			} catch (e) {
				failCount++;
			}
		}

		// 刷新比对结果
		this.compareResult = await this.plugin.compareLocalWithCloud(this.localImages, effectiveBed);
		this.renderContent();
		const parts: string[] = [];
		if (successCount > 0) parts.push(`${successCount} 张新上传`);
		if (dedupCount > 0) parts.push(`${dedupCount} 张去重命中`);
		if (failCount > 0) parts.push(`${failCount} 张失败`);
		new Notice(`批量完成：${parts.join("，")}`);
	}

	// ==================== 工具方法 ====================

	private insertUrl(url: string) {
		const editor = this.app.workspace.activeEditor?.editor;
		if (editor) {
			const cursor = editor.getCursor();
			const alt = url.split("/").pop()?.split("?")[0] || "";
			editor.replaceRange(`![${alt}](${url})`, cursor);
		} else {
			new Notice("请先打开一个编辑器");
		}
	}

	private async deleteCloudFile(filename: string, bedType?: ImageBedType) {
		if (!confirm(`确定要删除云端文件 "${filename}" 吗？`)) return;
		// 优先使用传入的 bedType，否则从 selectedBed 获取
		const targetBed = bedType || this.selectedBed;
		const result = await this.plugin.deleteCloudFile(filename, targetBed);
		if (result.success) {
			new Notice("删除成功");
			await this.refresh();
		} else {
			new Notice(`删除失败: ${result.error}`);
		}
	}


	private buildFileNameRefCount(): Map<string, number> {
		const map = new Map<string, number>();
		for (const img of this.localImages) {
			const fileName = extractFileName(img.pure);
			if (fileName) {
				map.set(fileName, (map.get(fileName) || 0) + 1);
			}
		}
		return map;
	}

	private getFileExtension(filename: string): string {
		const parts = filename.split(".");
		return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
	}
}
