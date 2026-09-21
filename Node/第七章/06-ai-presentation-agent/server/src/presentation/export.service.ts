import { Injectable } from '@nestjs/common'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import PptxGenJS from 'pptxgenjs'
import type {
	ExportRecord,
	OutlineVersion,
	PageTask,
	Presentation
} from './presentation.types.js'

/** 将已经通过领域校验的当前页面导出为可继续编辑的 PPTX。 */
@Injectable()
export class PresentationExportService {
	private readonly outputDir = path.resolve(
		process.cwd(),
		process.env.EXPORT_DIR ?? 'data/exports'
	)

	/**
	 * 导出演示文稿文件。
	 * @param presentation
	 * @param outline
	 * @param pages
	 * @returns
	 */
	async export(
		presentation: Presentation,
		outline: OutlineVersion,
		pages: PageTask[]
	): Promise<ExportRecord> {
		await mkdir(this.outputDir, { recursive: true })
		const PptxConstructor = PptxGenJS as unknown as new () => any
		const pptx = new PptxConstructor()
		pptx.layout = 'LAYOUT_WIDE'
		pptx.author = 'DeckFlow Agent'
		pptx.subject = presentation.requirements.topic
		pptx.title = outline.title
		pptx.company = 'Agent Course'
		pptx.lang = 'zh-CN'
		pptx.theme = {
			headFontFace: presentation.theme.headFontFace,
			bodyFontFace: presentation.theme.bodyFontFace,
			lang: 'zh-CN'
		}

		for (const page of pages) {
			const isCover = page.order === 1
			const pageStyle = page.styleOverride
			const layoutStyle =
				pageStyle?.layoutStyle ?? presentation.theme.layoutStyle
			const titleAlign = pageStyle?.titleAlign ?? presentation.theme.titleAlign
			const isCompact =
				(pageStyle?.density ?? presentation.theme.density) === 'compact'
			const backgroundColor =
				pageStyle?.backgroundColor ??
				(isCover
					? presentation.theme.coverBackgroundColor
					: presentation.theme.backgroundColor)
			const textColor =
				pageStyle?.textColor ??
				(isCover
					? presentation.theme.coverTextColor
					: presentation.theme.textColor)
			const mutedColor =
				pageStyle?.mutedColor ??
				(isCover
					? presentation.theme.coverMutedColor
					: presentation.theme.mutedColor)
			const accentColor =
				pageStyle?.accentColor ?? presentation.theme.accentColor
			const artifact = page.artifacts.find(
				(item) => item.artifactId === page.currentArtifactId
			)
			if (!artifact) throw new Error(`页面 ${page.pageId} 缺少当前产物。`)

			const slide = pptx.addSlide()
			slide.background = { color: backgroundColor }
			const accentShape =
				layoutStyle === 'top_line'
					? { x: 0, y: 0, w: 13.333, h: 0.12 }
					: layoutStyle === 'corner_block'
						? { x: 0.85, y: 0.55, w: 0.72, h: 0.1 }
						: { x: 0, y: 0, w: 0.18, h: 7.5 }
			slide.addShape(pptx.ShapeType.rect, {
				...accentShape,
				fill: { color: accentColor },
				line: { color: accentColor }
			})
			slide.addText(String(page.order).padStart(2, '0'), {
				x: 11.7,
				y: 0.45,
				w: 0.8,
				h: 0.4,
				fontFace: 'Aptos Mono',
				fontSize: 11,
				color: mutedColor,
				align: 'right',
				margin: 0
			})
			slide.addText(artifact.title, {
				x: titleAlign === 'center' ? 1.35 : 0.85,
				y: layoutStyle === 'corner_block' ? 1.0 : 0.75,
				w: 10.6,
				h: 1.2,
				fontSize: isCover ? 31 : 26,
				fontFace: pageStyle?.headFontFace ?? presentation.theme.headFontFace,
				bold: true,
				color: textColor,
				align: titleAlign,
				margin: 0,
				breakLine: false
			})
			slide.addText(artifact.subtitle, {
				x: 0.88,
				y: 2.0,
				w: 10.2,
				h: 0.45,
				fontSize: 12,
				fontFace: pageStyle?.bodyFontFace ?? presentation.theme.bodyFontFace,
				color: mutedColor,
				align: titleAlign,
				margin: 0
			})
			slide.addText(
				artifact.bullets.map((text) => ({
					text,
					options: { bullet: { indent: 15 }, hanging: 4, breakLine: true }
				})),
				{
					x: 0.92,
					y: isCompact ? 2.6 : 2.75,
					w: 10.6,
					h: isCompact ? 3.4 : 3.2,
					fontSize: isCompact ? 16 : 18,
					fontFace: pageStyle?.bodyFontFace ?? presentation.theme.bodyFontFace,
					color: textColor,
					breakLine: false,
					margin: 0.04,
					paraSpaceAfterPt: isCompact ? 10 : 16,
					valign: 'mid'
				}
			)
			slide.addText(
				`Outline v${outline.version} · Revision ${page.pageRevision}`,
				{
					x: 0.88,
					y: 6.85,
					w: 5.5,
					h: 0.3,
					fontSize: 9,
					color: mutedColor,
					margin: 0
				}
			)
			slide.addNotes(artifact.speakerNote)
		}

		const safeName = presentation.requirements.topic
			.replace(/[\\/:*?"<>|]/g, '-')
			.slice(0, 50)
		const fileName = `${safeName}-v${outline.version}.pptx`
		const filePath = path.join(this.outputDir, fileName)
		await pptx.writeFile({ fileName: filePath })

		return {
			fileName,
			filePath,
			outlineVersion: outline.version,
			pageArtifactIds: pages.map((page) => page.currentArtifactId!),
			createdAt: new Date().toISOString()
		}
	}
}
