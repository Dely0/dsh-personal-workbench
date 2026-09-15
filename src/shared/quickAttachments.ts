/**
 * 快速录入附件的**前后端共享常量**（v1.15.1）。
 *
 * 为什么单独放 `shared/`：这些数字必须**前后端完全一致**，否则会出现
 * "界面允许选、服务端立刻 413"这种自相矛盾的体验。
 * 两处各写一份字面量就是"同一个语义两处实现"（本项目最大的 bug 类别）。
 *
 * 客户端可用（不 import 任何 node: 模块）；服务端护栏见
 * `src/api/routes/quick-attachments.ts`。
 */

/** 单份文档解码后的字节上限（5 MiB）。 */
export const MAX_QUICK_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** 一次快速录入最多几张图片。 */
export const MAX_QUICK_IMAGES = 10

/** 一次快速录入最多几份文档。 */
export const MAX_QUICK_DOCUMENTS = 4

/** 支持粘贴/拖入的图片 MIME（与宿主 `EncodedImageAttachment` 的四种一致）。 */
export const QUICK_IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 支持解析正文的文档 MIME。 */
export const QUICK_DOCUMENT_MEDIA_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

/** 支持解析正文的文档扩展名（有些浏览器给不出 MIME）。 */
export const QUICK_DOCUMENT_EXTENSIONS = /\.(pdf|docx)$/i

/**
 * 宿主渲染的"模型不收图"占位文案前缀。
 *
 * 宿主在 `inputModalities` 已声明且不含 `image` 时，把图片块换成
 * `[image omitted because this model accepts text only; attachment sha256:…]`。
 * 我们**不依赖**它来做提示（那是事后补救），只在测试与说明里引用它，
 * 保证"我们判定为 rejected"与"宿主真的会替换"这两件事说的是同一件事。
 */
export const TEXT_ONLY_IMAGE_PLACEHOLDER_PREFIX = '[image omitted because this model accepts text only'
