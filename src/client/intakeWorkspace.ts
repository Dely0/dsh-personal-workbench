/**
 * 「这次 AI 会话该用哪个工作区」——纯函数判定（v1.15.1）。
 *
 * ## 修的真 bug（fork 顺手修了，我们至今还在）
 *
 * `src/client/index.tsx` 原先写的是 `let workspaceId = ws.items[0]?.workspaceId`：
 * **随手取列表里第一个工作区**。当任务没填路径、默认工作区也为空时，
 * 会话会挂到列表里第一个工作区上 —— 它可能与用户当前连接的完全无关，
 * 甚至可能是**另一个任务自动生成的资料夹**（于是本次澄清的文件全落进了别人的任务目录）。
 *
 * ## 判据（只有这一处实现）
 *
 * 1. **当前会话的 cwd** 精确命中的已注册工作区 —— 用户就在那儿，最不意外；
 * 2. 排除"任务资料夹型"工作区（位于默认任务根目录下的那些）后**只剩一个**；
 * 3. 只有一个已注册工作区时用它（没有歧义可言）；
 * 4. 以上都不成立 → **明确拒绝并给出可读原因**，而不是猜一个。
 *
 * 第 4 条是刻意的：本项目规范 P5 是"失败必须可观测，不许半死不活地降级"。
 * 猜错工作区的后果是"文件悄悄落到别的项目里"，比一条"请先打开工作区"的提示严重得多。
 *
 * ## 硬约束
 *
 * 不 import React、不碰 DOM、不读 `document` —— 可被 `node --test` 直接测。
 */
import { isWslStylePath, pathIsUnderRoot, workspacePathKeys } from './workspacePath.js'

/**
 * 归一化一个路径用于**比较**。
 *
 * ⚠️ 实现已迁到 `workspacePath.ts`（唯一权威）：`taskFolder.ts` 的"老路径必须在默认根目录下"
 * 判据也要用它，两处各一份就是"同一个语义被独立计算多次"（fresh-eyes 审查点名）。
 * 这里只做**再导出**，不打断既有引用与测试。
 */
export { workspacePathKeys }

/** `path` 是否位于 `root` 之下（含 root 自身）。同上：唯一实现在 `workspacePath.ts`。 */
const isUnderRoot = pathIsUnderRoot

/** 参与判定的工作区条目（只声明用得到的字段）。 */
export interface IntakeWorkspaceItem {
  readonly workspaceId: string
  readonly path?: string
}

export interface IntakeWorkspaceInput {
  readonly items: readonly IntakeWorkspaceItem[]
  /** 当前会话的 cwd（读不到就给空串/undefined）。 */
  readonly currentCwd?: string | null
  /** 默认任务根目录（设置里的 `defaultWorkspace`）；空串表示未配置。 */
  readonly tasksRoot?: string | null
}

/** 判定结果：`ok: false` 时 `reason` 必须是人能看懂、能照做的一句话。 */
export type IntakeWorkspaceVerdict =
  | { readonly ok: true; readonly workspaceId: string; readonly because: 'current-cwd' | 'only-candidate' | 'single-workspace' }
  | { readonly ok: false; readonly reason: string }

/**
 * 选出本次 AI 会话要挂的工作区。
 *
 * @param input - 已注册工作区列表 + 当前会话 cwd + 默认任务根目录。
 * @returns 选中的工作区，或一条可读的拒绝原因。
 */
export function pickIntakeWorkspace(input: IntakeWorkspaceInput): IntakeWorkspaceVerdict {
  const items = input.items.filter((item) => typeof item.workspaceId === 'string' && item.workspaceId !== '')
  if (items.length === 0) {
    return { ok: false, reason: '没有可用工作区，请先在 DSH 中打开一个工作区' }
  }
  const cwdKeys = workspacePathKeys(input.currentCwd ?? '')
  if (cwdKeys.length > 0) {
    const current = items.find((item) => {
      if (typeof item.path !== 'string') return false
      const keys = workspacePathKeys(item.path)
      return keys.some((key) => cwdKeys.includes(key))
    })
    if (current !== undefined) return { ok: true, workspaceId: current.workspaceId, because: 'current-cwd' }
  }
  const tasksRoot = String(input.tasksRoot ?? '').trim()
  /**
   * 排除"任务资料夹型"工作区：给**新任务**澄清时落进别的任务的资料夹是明确的错误
   * （这正是 `ws.items[0]` 那条 bug 最坏的一种表现）。
   */
  const candidates = tasksRoot === ''
    ? items
    : items.filter((item) => typeof item.path !== 'string' || !isUnderRoot(item.path, tasksRoot))
  if (items.length === 1) return { ok: true, workspaceId: items[0].workspaceId, because: 'single-workspace' }
  if (candidates.length === 1) return { ok: true, workspaceId: candidates[0].workspaceId, because: 'only-candidate' }
  const listed = items
    .map((item) => (typeof item.path === 'string' && item.path !== '' ? item.path : item.workspaceId))
    .slice(0, 5)
    .join('、')
  return {
    ok: false,
    reason: `无法确定这次会话该用哪个工作区（已注册 ${items.length} 个：${listed}）。`
      + '请在 DSH 里切到目标任务所在的工作区，或在「快速录入」里显式选择工作区、在设置里配置默认工作区后重试。'
      + '（不会随手取第一个工作区 —— 那会把文件建进无关的项目目录。）',
  }
}

/**
 * 从 `workspaces.create()` 的返回值里取出 `workspaceId`。
 *
 * ## 为什么需要这个纯函数（2026-09-26 核对宿主契约时发现，**两版都存在**）
 *
 * 工作台原先写的是 `if (typeof created?.workspaceId === 'string') workspaceId = created.workspaceId`，
 * 但宿主这个方法返回的是 **generated Remote 结果**，形状是
 * `{ ok: true, value: { workspace: { workspaceId, path, … } } }` ——
 * 工作区 id **嵌在 `value.workspace` 里**，顶层从来没有 `workspaceId`。
 * （0.1.5 与 0.1.7-rc.2 的实现逐字一致：`async create(input) { const r = await this.remote.create(input); if (r.ok) this.upsert(r.value.workspace); return r }`。）
 *
 * 后果不是崩溃，而是**静默忽略用户显式选的工作区**：`create()` 明明成功建/取到了工作区，
 * 我们没读出 id → 落回 `pickIntakeWorkspace()`（按当前会话 cwd/唯一候选猜）。
 * 这正是规范里点名的"静默丢件"类别，所以读不出来时要能被上层看见（返回 `undefined`，
 * 由调用方决定报错还是回落）。
 *
 * @param result - `workspaces.create()` 的返回值（形状未知，按结构判定）
 * @returns 取到的 workspaceId；取不到返回 `undefined`（**不猜**）
 */
export function readCreatedWorkspaceId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const record = result as {
    ok?: unknown
    value?: { workspace?: { workspaceId?: unknown } }
    workspaceId?: unknown
  }
  /** 显式失败（`{ok:false,error}`）时不读 value。 */
  if (record.ok === false) return undefined
  const nested = record.value?.workspace?.workspaceId
  if (typeof nested === 'string' && nested !== '') return nested
  /**
   * 兼容"直接把 id 放在结果上"的形态（早期替身/未来包装）：**读得到就用**，
   * 这样宿主若回到扁平形状也不会又静默丢一次。
   */
  if (typeof record.workspaceId === 'string' && record.workspaceId !== '') return record.workspaceId
  return undefined
}

