/**
 * 快速录入的**附件与澄清提示词**纯逻辑（v1.15.1）。
 *
 * 从 `index.tsx` 抽出来的原因很直接：**凡是想锁住的行为，都要先搬到纯 `.ts` 模块里**
 * （客户端产物是单文件 bundle，`.tsx` 在本机没转译器也不易测）。
 * 这里锁住三件容易写错、且用户能立刻感觉到的事：
 *
 * 1. **收哪些文件**（4 种图片 MIME + PDF/DOCX）与**张数上限**；
 * 2. **不收的文件必须给可读原因，绝不静默丢弃**（本项目规范第 7 条：
 *    子任务 `type_code` 写错被静默跳过导致"5 个子任务凭空少 2 个"，是同类事故）；
 * 3. **澄清提示词里必须声明任务资料夹**（新口径：会话用当前工作区，
 *    任务文件放 `<当前工作区>/<任务ID>-<标题片段>/`，而不是给每个任务注册一个 AI 工作区）。
 *
 * 不 import React、不碰 DOM → 可被 `node --test` 直接测。
 */
import {
  MAX_QUICK_ATTACHMENT_BYTES, MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES,
  QUICK_DOCUMENT_EXTENSIONS, QUICK_DOCUMENT_MEDIA_TYPES, QUICK_IMAGE_MEDIA_TYPES,
} from '../shared/quickAttachments.js'

export {
  MAX_QUICK_ATTACHMENT_BYTES, MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES,
  QUICK_DOCUMENT_EXTENSIONS, QUICK_DOCUMENT_MEDIA_TYPES, QUICK_IMAGE_MEDIA_TYPES,
}

/** 文档单份字节上限（与服务端 `MAX_QUICK_ATTACHMENT_BYTES` 同源，避免两处不一致）。 */
export const MAX_QUICK_DOCUMENT_BYTES = MAX_QUICK_ATTACHMENT_BYTES

export type QuickImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 宿主 `PromptContentPart` 的本地形状声明（只声明我们用到的两个变体）。 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: QuickImageMediaType; readonly data: string; readonly name?: string }

/** 待发送的图片草稿。 */
export interface QuickImageDraft {
  readonly id: string
  readonly file: File
  readonly previewUrl: string
}

/** 已解析出正文的文档草稿（正文由服务端抽取，客户端不解析二进制）。 */
export interface QuickDocumentDraft {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  readonly content: string
  readonly truncated: boolean
}

export type QuickAttachmentDraft = QuickImageDraft | QuickDocumentDraft

/** 只依赖 `type`/`name`/`size`，便于单测用字面量构造。 */
export interface FileLike {
  readonly type: string
  readonly name: string
  readonly size?: number
}

export const isQuickImageFile = (file: FileLike): boolean => QUICK_IMAGE_MEDIA_TYPES.includes(file.type)

export const isQuickDocumentFile = (file: FileLike): boolean =>
  QUICK_DOCUMENT_MEDIA_TYPES.includes(file.type) || QUICK_DOCUMENT_EXTENSIONS.test(file.name)

export const isQuickAttachmentFile = (file: FileLike): boolean => isQuickImageFile(file) || isQuickDocumentFile(file)

export const isQuickImageDraft = (draft: QuickAttachmentDraft): draft is QuickImageDraft => 'previewUrl' in draft

/** 不接收的文件：带**可读原因**回给界面（而不是悄悄 continue 掉）。 */
export interface RejectedQuickFile {
  readonly name: string
  readonly reason: string
}

export interface QuickFilePartition {
  readonly images: FileLike[]
  readonly documents: FileLike[]
  readonly rejected: RejectedQuickFile[]
}

/**
 * 把用户拖入/粘贴/选中的文件分成"能收的"与"不收的（带原因）"。
 *
 * @param files - 本次新增的文件。
 * @param existing - 已经加进去的附件（用于判断张数上限）。
 * @returns 分类结果；`rejected` 必须被界面显示出来。
 */
export function partitionQuickFiles(files: readonly FileLike[], existing: readonly QuickAttachmentDraft[] = []): QuickFilePartition {
  const images: FileLike[] = []
  const documents: FileLike[] = []
  const rejected: RejectedQuickFile[] = []
  let imageCount = existing.filter(isQuickImageDraft).length
  let documentCount = existing.length - imageCount
  for (const file of files) {
    if (isQuickImageFile(file)) {
      if (imageCount >= MAX_QUICK_IMAGES) {
        rejected.push({ name: file.name, reason: `图片最多 ${MAX_QUICK_IMAGES} 张，这一张没有被加入` })
        continue
      }
      imageCount += 1
      images.push(file)
      continue
    }
    if (isQuickDocumentFile(file)) {
      if (documentCount >= MAX_QUICK_DOCUMENTS) {
        rejected.push({ name: file.name, reason: `一次最多 ${MAX_QUICK_DOCUMENTS} 份文档，这一份没有被加入` })
        continue
      }
      if (typeof file.size === 'number' && file.size > MAX_QUICK_DOCUMENT_BYTES) {
        rejected.push({ name: file.name, reason: `文档超过 5MB（${file.size} 字节），无法解析正文` })
        continue
      }
      documentCount += 1
      documents.push(file)
      continue
    }
    rejected.push({
      name: file.name,
      reason: '只支持 PNG/JPEG/WebP/GIF 图片与 PDF/DOCX 文档；其它类型不会被解析，也不会上传',
    })
  }
  return { images, documents, rejected }
}

/** 附件情况说明（写进提示词，让 AI 知道"还有图/文档"，并提示它把要点落到 description）。 */
export function quickAttachmentSummary(attachments: readonly QuickAttachmentDraft[]): string {
  const images = attachments.filter(isQuickImageDraft).length
  const documents = attachments.length - images
  if (images === 0 && documents === 0) return ''
  const parts: string[] = []
  if (images > 0) parts.push(`${images} 张图片`)
  if (documents > 0) parts.push(`${documents} 份 PDF/DOCX 文档`)
  return `用户还附加了 ${parts.join('、')}作为任务内容，请结合附件理解需求；`
    + '如果附件里包含关键任务信息、错误截图、界面状态、待办内容、通知或需求说明，'
    + '请在最终任务 description 中用文字概括，便于入库后检索。'
}

/** 用户一句话为空但带了附件时，用一句可读的占位（不要留空引导 AI 瞎猜）。 */
export function quickTaskPlaceholder(text: string, attachments: readonly QuickAttachmentDraft[]): string {
  const trimmed = text.trim()
  if (trimmed !== '') return trimmed
  const images = attachments.filter(isQuickImageDraft).length
  const documents = attachments.length - images
  if (images > 0 && documents > 0) return '（见附件图片和文档）'
  if (images > 0) return '（见附件图片）'
  if (documents > 0) return '（见附件文档）'
  return '（未提供内容）'
}

/** 一份已抽取正文的文档，拼进提示词的形状。 */
export interface QuickDocumentText {
  readonly name: string
  readonly content: string
  readonly truncated: boolean
}

export interface QuickIntakePromptInput {
  readonly taskText: string
  readonly attachments: readonly QuickAttachmentDraft[]
  readonly documentTexts: readonly QuickDocumentText[]
  readonly nowIso: string
  /** 本次会话实际使用的工作区根目录（读得到就给，读不到用兜底文案）。 */
  readonly workspaceRootLabel: string
  /** 澄清阶段**先分配**的任务 id（确认草稿时复用，不再靠"用户原话"建文件夹）。 */
  readonly reservedTaskId: string
  /** 任务资料夹绝对路径；为空表示这次没有资料夹。 */
  readonly taskFolderPath: string
  /** 任务资料夹相对工作区的路径（`./<folder>/`）。 */
  readonly taskFolderRelative: string
  /** 本次会话使用的模型（可读标签）。 */
  readonly modelLabel: string
}

/**
 * 澄清阶段的完整提示词。
 *
 * 关键约定（与 `docs/2026-09-15-fork-survey.md` 3.1 一致）：
 * **不再为每个任务注册 AI 工作区**，会话直接用当前工作区，
 * 并在提示词里声明任务资料夹；任务相关文件都放进去，不要散在工作区根目录。
 */
export function buildQuickIntakePrompt(input: QuickIntakePromptInput): string {
  const attachmentInstruction = quickAttachmentSummary(input.attachments)
  const documentBlock = input.documentTexts.length === 0
    ? ''
    : `\n\n附件文档正文（已由工作台解析${input.documentTexts.some((doc) => doc.truncated) ? '，其中部分已截断' : ''}）：\n`
      + input.documentTexts
        .map((doc) => `「${doc.name}」${doc.truncated ? '（内容已截断）' : ''}\n"""\n${doc.content}\n"""`)
        .join('\n\n')
  const folderBlock = input.taskFolderPath === ''
    ? ''
    : `\n任务资料夹：${input.taskFolderPath}`
      + (input.taskFolderRelative === '' ? '' : `\n任务资料夹相对路径：${input.taskFolderRelative}`)
  const folderInstruction = input.taskFolderPath === ''
    ? '如需在澄清阶段创建文件，请放在当前工作区内并说明位置。'
    : `如需在澄清阶段创建文件，请放在${input.taskFolderRelative === '' ? '上述任务资料夹' : `工作区内的 ${input.taskFolderRelative}`}，不要在工作区根目录散放文件。`
  return `你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。\n\n`
    + `用户想创建的任务是：\n「${quickTaskPlaceholder(input.taskText, input.attachments)}」`
    + `${attachmentInstruction === '' ? '' : `\n\n${attachmentInstruction}`}${documentBlock}\n\n`
    + `当前时间：${input.nowIso}\n`
    + `本次会话模型：${input.modelLabel}\n`
    + `当前工作区根目录：${input.workspaceRootLabel}\n`
    + `本次预分配任务 id：${input.reservedTaskId}${folderBlock}\n\n`
    + `请先澄清必要信息（一次一个主题，最多5轮）。除非用户明确要求为这条任务指定资料夹，否则不要再询问工作区路径。`
    + `信息足够后只能调用 workbench_submit_task 提交结构化任务草稿，`
    + `并且必须传入 task_id="${input.reservedTaskId}"`
    + `${input.taskFolderPath === '' ? '' : `、workspace_path="${input.taskFolderPath}"`}。`
    + `${folderInstruction}不要执行任务本身。`
}
