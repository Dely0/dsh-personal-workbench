/**
 * 快速录入 / 澄清会话**共用的三个浏览器侧小工具**（D17/P6-2 从 `src/client/index.tsx` 搬出）。
 *
 * ## 为什么要单独成模块
 * 这三个函数原本是入口的模块级函数（`newTaskId` / `fileToBase64` / `quickImageToPromptPart`）。
 * D17 把**快速录入域**（`hooks/useWorkbenchQuickIntake.ts`：附件草稿要用 `newTaskId` +
 * `fileToBase64`）与 **AI 会话域**（`hooks/useWorkbenchAISessions.ts`：澄清前预留任务 id 要用
 * `newTaskId`，图片 prompt part 要用 `quickImageToPromptPart`）分别搬出入口之后，
 * **两个 hook 都要用它们**，而 hook 不能 import 入口（`index.tsx` 反过来 import 两个 hook，
 * 会成环）。按本仓既有规矩——"凡是想被两处共用、又要能被 `node --test` 直接测的，
 * 先搬进纯 `.ts` 模块"——落在本文件。
 *
 * ## 三件事各自的语义
 * 1. `newTaskId()`：生成一个任务 id。澄清阶段要**提前**拿到 id（用它建任务资料夹、
 *    写进提示词），所以不能等仓储层生成。优先 `crypto.randomUUID()`（与库里的形态一致），
 *    老浏览器 / 非安全上下文退回时间戳 + 随机串。
 * 2. `fileToBase64(file)`：本地文件 → base64（**不带** data URL 前缀）。
 *    两个用途：宿主原生多模态的图片 part、服务端抽取 PDF/DOCX 正文时的上传体。
 * 3. `quickImageToPromptPart(image)`：图片草稿 → 宿主 `PromptContentPart`。
 *
 * 不 import React、不碰 React 状态（`fileToBase64` 用浏览器自带的 `FileReader`）。
 */
import {
  type PromptContentPart, type QuickImageDraft, type QuickImageMediaType,
} from './quickAttachments.js'

/**
 * 生成一个任务 id。
 *
 * 澄清阶段要**提前**拿到 id（用它建任务资料夹、写进提示词），
 * 所以不能等仓储层生成。优先 `crypto.randomUUID()`（与库里的形态一致），
 * 老浏览器/非安全上下文退回时间戳+随机串。
 */
export function newTaskId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID()
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 本地文件 → base64（不含 data URL 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('图片读取失败'))
      else resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 图片草稿 → 宿主 `PromptContentPart`（base64 不带 data URL 前缀）。 */
export async function quickImageToPromptPart(image: QuickImageDraft): Promise<PromptContentPart> {
  const mediaType = (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.file.type)
    ? image.file.type
    : 'image/png') as QuickImageMediaType
  return {
    type: 'image',
    mediaType,
    data: await fileToBase64(image.file),
    ...(image.file.name === '' ? {} : { name: image.file.name }),
  }
}
