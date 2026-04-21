/**
 * 模块1：链接解析器
 * 解析 Markdown 中的 ![]() 和 ![[ ]] 格式图片链接
 */

import { ImageLink } from "../types";

/** Markdown 图片链接: ![alt](url "title") */
const MD_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** Wiki 嵌入链接: ![[path]] 或 ![[path|params]] */
const WIKI_IMAGE_REGEX = /!\[\[([^\]|]+?)(?:\|([^\]]*))?]]/g;

/** HTML img 标签: <img src="url" ...> */
const HTML_IMG_REGEX = /<img\b(?:(?![^>]*src=)|(?:(?=[^>]*src=)[^>]*))src=["']([^"']+)["'][^>]*>/gi;

export class LinkParser {
	/**
	 * 解析文本中的所有图片链接
	 */
	parse(content: string): ImageLink[] {
		const links: ImageLink[] = [];

		// 解析 Markdown 格式 ![](url)
		MD_IMAGE_REGEX.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = MD_IMAGE_REGEX.exec(content)) !== null) {
			const linkContent = match[2];
			const link = this.parseLinkContent(linkContent, match[0], match.index, content);
			if (link) {
				links.push(link);
			}
		}

		// 解析 Wiki 格式 ![[path|params]]
		WIKI_IMAGE_REGEX.lastIndex = 0;
		while ((match = WIKI_IMAGE_REGEX.exec(content)) !== null) {
			const pure = match[1].trim();
			const params = match[2]?.trim() || "";

			if (!pure) continue;

			const type = this.detectLinkType(pure);
			const line = this.getLineNumber(content, match.index);

			links.push({
				raw: match[0],
				pure,
				params,
				type,
				count: 0,
				files: [],
				line,
			});
		}

		// 解析 HTML <img> 标签
		HTML_IMG_REGEX.lastIndex = 0;
		while ((match = HTML_IMG_REGEX.exec(content)) !== null) {
			const pure = match[1].trim();
			if (!pure) continue;

			const type = this.detectLinkType(pure);
			const line = this.getLineNumber(content, match.index);

			links.push({
				raw: match[0],
				pure,
				params: "",
				type,
				count: 0,
				files: [],
				line,
			});
		}

		return links;
	}

	/**
	 * 解析 Markdown 链接内容，拆分 pure 和 params
	 */
	private parseLinkContent(linkContent: string, fullMatch: string, matchIndex: number, content: string): ImageLink | null {
		// Markdown 格式支持 "title" 后缀: ![](url "title")
		// 先去掉末尾的 "title" 部分
		const titleMatch = linkContent.match(/^(.+?)\s+"([^"]*)"$/);
		let pure: string;
		let params: string;

		if (titleMatch) {
			pure = titleMatch[1].trim();
			params = "";
		} else {
			// 处理 | 分隔的参数: url|params
			const pipeIndex = linkContent.indexOf("|");
			if (pipeIndex === -1) {
				pure = linkContent;
				params = "";
			} else {
				pure = linkContent.substring(0, pipeIndex).trim();
				params = linkContent.substring(pipeIndex + 1).trim();
			}
		}

		if (!pure) return null;

		const type = this.detectLinkType(pure);

		return {
			raw: fullMatch,
			pure,
			params,
			type,
			count: 0,
			files: [],
			line: this.getLineNumber(content, matchIndex),
		};
	}

	/**
	 * 检测链接类型
	 */
	private detectLinkType(pure: string): "local" | "https" | "http" {
		if (pure.startsWith("https://")) return "https";
		if (pure.startsWith("http://")) return "http";
		// 协议相对 URL: //cdn.example.com/img.png
		if (pure.startsWith("//")) return "http";
		return "local";
	}

	/**
	 * 根据 offset 计算行号（1-based）
	 */
	private getLineNumber(content: string, offset: number): number {
		return content.substring(0, offset).split("\n").length;
	}

	/**
	 * 从文件内容中提取所有图片链接（用于替换操作）
	 */
	extractAllRawLinks(content: string): { raw: string; fullMatch: string }[] {
		const results: { raw: string; fullMatch: string }[] = [];
		let match: RegExpExecArray | null;

		// Markdown 格式
		MD_IMAGE_REGEX.lastIndex = 0;
		while ((match = MD_IMAGE_REGEX.exec(content)) !== null) {
			results.push({ raw: match[2], fullMatch: match[0] });
		}

		// Wiki 格式
		WIKI_IMAGE_REGEX.lastIndex = 0;
		while ((match = WIKI_IMAGE_REGEX.exec(content)) !== null) {
			results.push({ raw: match[1].trim(), fullMatch: match[0] });
		}

		// HTML <img> 格式
		HTML_IMG_REGEX.lastIndex = 0;
		while ((match = HTML_IMG_REGEX.exec(content)) !== null) {
			results.push({ raw: match[1].trim(), fullMatch: match[0] });
		}

		return results;
	}
}
