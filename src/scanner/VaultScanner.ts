/**
 * 模块2：全库扫描器
 * 扫描整个库，统计每个图片链接的使用次数与位置
 */

import { App, TFile } from "obsidian";
import { LinkParser } from "../parser/LinkParser";
import { ImageLink } from "../types";

export class VaultScanner {
	private app: App;
	private parser: LinkParser;

	constructor(app: App, parser: LinkParser) {
		this.app = app;
		this.parser = parser;
	}

	/**
	 * 扫描整个库，返回所有图片链接的使用统计
	 * 对本地 wikilink 使用 metadataCache 解析为库内绝对路径作为聚合 key
	 */
	async scan(): Promise<Map<string, ImageLink>> {
		const result = new Map<string, ImageLink>();
		const mdFiles = this.app.vault.getMarkdownFiles();

		for (const file of mdFiles) {
			const content = await this.app.vault.read(file);
			const links = this.parser.parse(content);

			for (const link of links) {
				// 对本地链接，用 metadataCache 解析相对路径为库内绝对路径
				let resolvedPath: string | undefined;
				if (link.type === "local") {
					const dest = this.app.metadataCache.getFirstLinkpathDest(link.pure, file.path);
					if (dest) {
						resolvedPath = dest.path;
					} else {
						// metadataCache 未命中时，基于引用文件目录手动拼接相对路径
						const srcDir = file.path.substring(0, file.path.lastIndexOf("/"));
						resolvedPath = srcDir ? `${srcDir}/${link.pure}` : link.pure;
					}
				}

				// 用解析后的路径作为聚合 key，确保同一文件不同引用方式合并
				const key = resolvedPath || link.pure;

				if (result.has(key)) {
					const existing = result.get(key)!;
					existing.count++;
					if (!existing.files.includes(file.path)) {
						existing.files.push(file.path);
					}
				} else {
					result.set(key, {
						...link,
						resolvedPath,
						count: 1,
						files: [file.path],
					});
				}
			}
		}

		return result;
	}
}
