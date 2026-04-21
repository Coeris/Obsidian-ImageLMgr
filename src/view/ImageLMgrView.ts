/**
 * ImageLMgr 右侧面板视图
 * 单栏布局：本地图片（含云端状态）+ 云端未引用文件
 */

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import ImageLMgrPlugin from "../main";
import { ImageLink, ImageBedType, CloudFile } from "../types";
import { extractFileName } from "../comparator/CloudComparator";
import { parseFrontmatter } from "../utils/FrontmatterParser";

export const VIEW_TYPE_IMAGE_LMGR = "imagelmgr";

/** 图片文件扩展名 */
const IMAGE_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif", "avif",
]);

/** 过滤模式 */
type FilterMode = "all" | "local" | "uploaded" | "unuploaded";

export class ImageLMgrView extends ItemView {
	private plugin: ImageLMgrPlugin;
	private localImages: ImageLink[] = [];
	private vaultImagesMap = new Map<string, ImageLink>();
	private cloudFiles: CloudFile[] = [];
	private selectedBed: ImageBedType = ImageBedType.Aliyun;
	/** 本地图片云端比对结果缓存 */
	private compareResult = new Map<string, { exists: boolean; url?: string }>();

	/** 过滤状态 */
	private searchKeyword = "";
	private filterMode: FilterMode = "all";

	/** 文件名 → 引用次数映射 */
	private fileNameRefCount = new Map<string, number>();

	/** #6 图床连接状态指示器元素 */
	private bedStatusEl: HTMLSpanElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ImageLMgrPlugin) {
		super(leaf);
		this.plugin = plugin;
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
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("imagelmgr-container");

		this.render(container);
		await this.refresh();
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
		this.fileNameRefCount = this.buildFileNameRefCount();

		// #6 刷新时自动检测连接状态
		this.testCurrentBed();

		// 并行请求云端列表和比对
		const [cloudFiles, compareResult] = await Promise.all([
			this.plugin.listCloudFiles(this.selectedBed),
			this.plugin.compareLocalWithCloud(this.localImages, this.selectedBed),
		]);
		this.cloudFiles = cloudFiles;
		this.compareResult = compareResult;

		this.renderContent();
	}

	// ==================== #6 图床连接健康检测 ====================

	private async testCurrentBed() {
		if (!this.bedStatusEl) return;

		this.bedStatusEl.className = "imagelmgr-bed-status imagelmgr-status-testing";
		this.bedStatusEl.textContent = "● 检测中...";

		const result = await this.plugin.testBedConnection(this.selectedBed);

		if (result.success) {
			this.bedStatusEl.className = "imagelmgr-bed-status imagelmgr-status-ok";
			this.bedStatusEl.textContent = "● 已连接";
		} else {
			this.bedStatusEl.className = "imagelmgr-bed-status imagelmgr-status-no";
			this.bedStatusEl.textContent = `● ${result.error || "连接失败"}`;
		}
	}

	private render(container: HTMLElement) {
		// 工具栏
		const toolbar = container.createDiv({ cls: "imagelmgr-toolbar" });

		// #6 连接状态指示器
		this.bedStatusEl = toolbar.createSpan({ cls: "imagelmgr-bed-status imagelmgr-status-unknown", text: "● 未检测" });
		this.bedStatusEl.title = "点击检测图床连接";
		this.bedStatusEl.style.cursor = "pointer";
		this.bedStatusEl.addEventListener("click", () => this.testCurrentBed());

		const refreshBtn = toolbar.createEl("button", { text: "刷新" });
		refreshBtn.addEventListener("click", async () => {
			refreshBtn.textContent = "刷新中...";
			refreshBtn.disabled = true;
			try {
				await this.refresh();
			} finally {
				refreshBtn.textContent = "刷新";
				refreshBtn.disabled = false;
			}
		});

		const uploadBtn = toolbar.createEl("button", { text: "批量上传" });
		uploadBtn.addEventListener("click", () => this.batchUpload());

		const createDirBtn = toolbar.createEl("button", { text: "新建目录" });
		createDirBtn.addEventListener("click", () => this.showCreateDirectoryDialog());

		// 搜索 + 过滤栏
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

		// 图床选择器
		const bedSelector = filterBar.createEl("select", { cls: "imagelmgr-bed-select" });
		for (const type of Object.values(ImageBedType)) {
			const option = bedSelector.createEl("option", { value: type, text: type });
			if (type === this.selectedBed) option.selected = true;
		}
		bedSelector.addEventListener("change", async (e) => {
			this.selectedBed = (e.target as HTMLSelectElement).value as ImageBedType;
			this.cloudFiles = await this.plugin.listCloudFiles(this.selectedBed);
			this.compareResult = await this.plugin.compareLocalWithCloud(this.localImages, this.selectedBed);
			this.renderContent();
		});

		// 过滤按钮组
		const filterGroup = filterBar.createDiv({ cls: "imagelmgr-filter-group" });
		const filters: { mode: FilterMode; label: string }[] = [
			{ mode: "all", label: "全部" },
			{ mode: "local", label: "本地" },
			{ mode: "uploaded", label: "已上传" },
			{ mode: "unuploaded", label: "未上传" },
		];
		for (const f of filters) {
			const btn = filterGroup.createEl("button", {
				text: f.label,
				cls: `imagelmgr-filter-btn ${f.mode === this.filterMode ? "active" : ""}`,
				attr: { "data-filter": f.mode },
			});
			btn.addEventListener("click", () => {
				this.filterMode = f.mode;
				filterGroup.querySelectorAll(".imagelmgr-filter-btn").forEach((el) => {
					el.classList.toggle("active", (el as HTMLElement).dataset.filter === f.mode);
				});
				this.renderContent();
			});
		}

		// 统一列表
		const list = container.createDiv({ cls: "imagelmgr-list", attr: { id: "imagelmgr-main-list" } });
		list.createDiv({ cls: "imagelmgr-loading", text: "加载中..." });
	}

	private renderContent() {
		const el = document.getElementById("imagelmgr-main-list");
		if (!el) return;
		el.empty();

		// 过滤本地图片
		const filteredLocal = this.applyLocalFilter(this.localImages);

		if (this.localImages.length === 0 && this.cloudFiles.length === 0) {
			el.createDiv({ cls: "imagelmgr-empty", text: "无数据" });
			return;
		}

		// ===== 第一部分：本地图片（含云端状态） =====
		if (filteredLocal.length > 0) {
			const uploadedCount = filteredLocal.filter(
				(img) => this.compareResult.get(img.pure)?.exists
			).length;

			// 分区标题
			const localHeader = el.createDiv({ cls: "imagelmgr-part-header" });
			localHeader.createSpan({ text: "本地图片", cls: "imagelmgr-part-title" });
			localHeader.createSpan({
				text: `${uploadedCount} 已上传 / ${filteredLocal.length - uploadedCount} 未上传`,
				cls: "imagelmgr-part-count",
			});

			for (const img of filteredLocal) {
				this.renderLocalItem(el, img);
			}
		}

		// ===== 第二部分：云端未引用文件 =====
		const cloudOnly = this.getCloudOnlyFiles();
		const filteredCloud = this.applyCloudFilter(cloudOnly);

		if (filteredCloud.length > 0) {
			// 分隔线
			el.createDiv({ cls: "imagelmgr-divider" });

			const cloudHeader = el.createDiv({ cls: "imagelmgr-part-header" });
			cloudHeader.createSpan({ text: "云端未引用文件", cls: "imagelmgr-part-title" });
			cloudHeader.createSpan({
				text: `${filteredCloud.length} 个`,
				cls: "imagelmgr-part-count",
			});

			// 一键清理按钮
			const cleanupBar = el.createDiv({ cls: "imagelmgr-cleanup-bar" });
			cleanupBar.createSpan({ text: "这些文件没有被任何笔记引用", cls: "imagelmgr-cleanup-info" });
			const cleanupBtn = cleanupBar.createEl("button", {
				text: "一键清理",
				cls: "imagelmgr-btn-sm imagelmgr-btn-danger",
			});
			cleanupBtn.addEventListener("click", () => {
				this.cleanupUnreferenced(filteredCloud);
			});

			// 判断是否有目录结构
			const hasDirectories = filteredCloud.some((f) => f.isDirectory);
			if (hasDirectories) {
				this.renderCloudWithDirectories(el, filteredCloud);
			} else {
				for (const file of filteredCloud) {
					if (!file.isDirectory) {
						this.renderCloudItem(el, file);
					}
				}
			}
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

		// 类型标签
		item.createSpan({ cls: `imagelmgr-badge imagelmgr-badge-${img.type}`, text: img.type });

		// 文件名（使用解析后的库内路径）
		const displayPath = img.resolvedPath || img.pure;
		item.createSpan({ cls: "imagelmgr-path", text: displayPath, title: img.pure });

		// 使用次数
		item.createSpan({ cls: "imagelmgr-count", text: `${img.count}次` });

		// 来源文件
		if (img.files.length > 0) {
			const filesSpan = item.createSpan({ cls: "imagelmgr-files", text: `← ${img.files.join(", ")}` });
			filesSpan.title = img.files.join("\n");
		}

		// 云端状态
		if (isUploaded) {
			item.createSpan({ cls: "imagelmgr-status imagelmgr-status-ok", text: "已上传" });
			if (result.url) {
				const link = item.createEl("a", {
					cls: "imagelmgr-link",
					text: "复制链接",
					href: result.url,
					title: result.url,
				});
				link.addEventListener("click", (e) => {
					e.preventDefault();
					navigator.clipboard.writeText(result.url!);
					new Notice("云端链接已复制");
				});
			}
		} else {
			item.createSpan({ cls: "imagelmgr-status imagelmgr-status-no", text: "未上传" });
			if (img.type === "local") {
				const uploadBtn = item.createEl("button", { text: "上传", cls: "imagelmgr-btn-sm" });
				uploadBtn.addEventListener("click", () => this.uploadSingleImage(img));
			}
		}

		// 双击跳转
		if (img.files.length > 0) {
			item.addEventListener("dblclick", () => {
				this.openFileAtLine(img.files[0], img.line);
			});
			item.style.cursor = "pointer";
		}
	}

	// ==================== 云端文件项 ====================

	private renderCloudItem(container: HTMLElement, file: CloudFile, indent: string = "") {
		const item = container.createDiv({ cls: "imagelmgr-item" });

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
		item.createSpan({ cls: "imagelmgr-count imagelmgr-count-unref", text: "未引用" });

		const actions = item.createDiv({ cls: "imagelmgr-actions" });

		const copyBtn = actions.createEl("button", { text: "复制", cls: "imagelmgr-btn-sm" });
		copyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(file.url).then(() => new Notice("链接已复制"));
		});

		const insertBtn = actions.createEl("button", { text: "插入", cls: "imagelmgr-btn-sm" });
		insertBtn.addEventListener("click", () => this.insertUrl(file.url));

		const deleteBtn = actions.createEl("button", { text: "删除", cls: "imagelmgr-btn-sm imagelmgr-btn-danger" });
		deleteBtn.addEventListener("click", () => this.deleteCloudFile(file.prefix || file.name));
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

	// ==================== 过滤逻辑 ====================

	private applyLocalFilter(images: ImageLink[]): ImageLink[] {
		let result = images;

		if (this.searchKeyword) {
			result = result.filter(
				(img) => img.pure.toLowerCase().includes(this.searchKeyword) ||
					img.files.some((f) => f.toLowerCase().includes(this.searchKeyword))
			);
		}

		if (this.filterMode === "local") {
			result = result.filter((img) => img.type === "local");
		} else if (this.filterMode === "uploaded") {
			result = result.filter((img) => this.compareResult.get(img.pure)?.exists);
		} else if (this.filterMode === "unuploaded") {
			result = result.filter((img) => !this.compareResult.get(img.pure)?.exists);
		}

		return result;
	}

	/**
	 * 获取云端未引用的文件（不被任何本地笔记引用的）
	 */
	private getCloudOnlyFiles(): CloudFile[] {
		return this.cloudFiles.filter(
			(f) => !f.isDirectory && (this.fileNameRefCount.get(extractFileName(f.name)) || 0) === 0
		);
	}

	private applyCloudFilter(files: CloudFile[]): CloudFile[] {
		if (this.searchKeyword) {
			return files.filter(
				(f) => f.name.toLowerCase().includes(this.searchKeyword) ||
					(f.prefix || "").toLowerCase().includes(this.searchKeyword)
			);
		}
		return files;
	}

	// ==================== 创建目录 ====================

	private showCreateDirectoryDialog() {
		const el = document.getElementById("imagelmgr-main-list");
		if (!el) return;

		const existing = el.querySelector(".imagelmgr-createdir-bar");
		if (existing) { existing.remove(); return; }

		const bar = el.createDiv({ cls: "imagelmgr-createdir-bar" });
		bar.createSpan({ text: "目录名:" });
		const input = bar.createEl("input", {
			type: "text",
			cls: "imagelmgr-createdir-input",
			attr: { placeholder: "例如: my-folder" },
		});

		const confirmBtn = bar.createEl("button", { text: "创建", cls: "imagelmgr-btn-sm" });
		confirmBtn.addEventListener("click", async () => {
			const dirName = input.value.trim();
			if (!dirName) { new Notice("请输入目录名"); return; }
			new Notice(`正在创建目录 ${dirName}...`);
			const result = await this.plugin.createCloudDirectory(dirName, this.selectedBed);
			if (result.success) {
				new Notice("目录创建成功");
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
		if (!confirm(`确定要删除 ${count} 个未引用的文件吗？此操作不可撤销。`)) return;

		let success = 0;
		let failed = 0;
		for (const file of files) {
			const result = await this.plugin.deleteCloudFile(file.prefix || file.name, this.selectedBed);
			if (result.success) success++; else failed++;
		}

		new Notice(`清理完成：删除 ${success} 个，失败 ${failed} 个`);
		await this.refresh();
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
			new Notice("该笔记的 Frontmeter 已禁用自动上传 (auto-upload: false)");
			return;
		}

		const resolvedPath = img.resolvedPath || img.pure;
		const fileName = extractFileName(resolvedPath);
		if (!fileName) { new Notice("无法解析文件名"); return; }

		// 优先用解析后的库内绝对路径查找文件
		let targetFile = this.app.vault.getAbstractFileByPath(resolvedPath) as any;
		if (!targetFile || !("read" in targetFile)) {
			targetFile = this.app.vault.getFiles().find((f) => f.name === fileName);
		}

		if (!targetFile || !("read" in targetFile)) {
			new Notice(`未找到文件: ${fileName}`);
			return;
		}

		try {
			const content = await this.app.vault.readBinary(targetFile as any);
			const blob = new Blob([content]);
			const file = new File([blob], fileName);

			// #10 使用生效图床类型
			const effectiveBed = await this.getEffectiveBedType();

			new Notice(`正在上传 ${fileName}...`);

			// #5 使用带去重的上传
			const result = await this.plugin.uploadImageWithDedup(file, effectiveBed);

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

			// #10 检查每张图的来源文件是否有 auto-upload 限制
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
					}
				} catch { /* 解析失败不阻止 */ }
			}

			new Notice(`[${i + 1}/${toUpload.length}] ${img.pure}`);
			try {
				const resolvedPath = img.resolvedPath || img.pure;
				const fileName = extractFileName(resolvedPath);
				if (!fileName) continue;

				let targetFile = this.app.vault.getAbstractFileByPath(resolvedPath) as any;
				if (!targetFile || !("read" in targetFile)) {
					targetFile = this.app.vault.getFiles().find((f) => f.name === fileName);
				}
				if (!targetFile || !("read" in targetFile)) continue;

				const content = await this.app.vault.readBinary(targetFile as any);
				const blob = new Blob([content]);
				const file = new File([blob], fileName);

				// #5 使用带去重的上传
				const result = await this.plugin.uploadImageWithDedup(file, effectiveBed);

				if (result.success && result.url) {
					if (result.cached) {
						dedupCount++;
					} else {
						successCount++;
						await this.plugin.replaceLink(img, result.url);
					}
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
			editor.replaceRange(`![](${url})`, cursor);
		} else {
			new Notice("请先打开一个编辑器");
		}
	}

	private async deleteCloudFile(filename: string) {
		if (!confirm(`确定要删除云端文件 "${filename}" 吗？`)) return;

		const result = await this.plugin.deleteCloudFile(filename, this.selectedBed);
		if (result.success) {
			new Notice("删除成功");
			await this.refresh();
		} else {
			new Notice(`删除失败: ${result.error}`);
		}
	}

	private openFileAtLine(filePath: string, line?: number) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file) { new Notice(`未找到文件: ${filePath}`); return; }
		this.app.workspace.getLeaf(false).openFile(file as any, {
			eState: line ? { line: line - 1 } : undefined,
		});
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
