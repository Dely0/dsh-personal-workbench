/**
 * repo 层共享原语：草稿确认骨架。
 *
 * 从 repo.ts 原样抽出（行为不变）。各领域模块的 confirm*Draft 都依赖它；
 * repo.ts 再导出以保持对外 API 不变。
 */
import type { DatabaseSync } from 'node:sqlite'
import { getDraft, nowIso, setDraftStatus, type DraftRow } from '../repo.js'

/**
 * 草稿确认的公共骨架：取草稿 → 校验 kind → 开事务 → 执行业务 → 标记 confirmed → 提交/回滚。
 *
 * 抽出来的原因：7 个 confirm*Draft 曾各自重复这 6 步（连 ROLLBACK 分支都一字不差），
 * 任何一步改动都要改 7 处。现在各函数只负责"确认时具体建什么"。
 *
 * @param kindCode 期望的草稿类型；不匹配返回 undefined（保持既有语义）
 * @param emptyValue kind 匹配但业务产出为空时的返回值（部分函数历史上返回 [] 而非 undefined）
 */
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; emptyValue: T },
): T
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options?: { at?: string },
): T | undefined
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; emptyValue?: T } = {},
): T | undefined {
  const at = options.at ?? nowIso()
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== kindCode) return options.emptyValue
  db.exec('BEGIN')
  try {
    const result = build(draft)
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
