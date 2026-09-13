/**
 * 工作区路径校验（v1.14.25，补子任务 4 的原始验收标准）。
 *
 * ## 为什么需要
 *
 * 原始验收标准写着：「路径校验：不存在/不可写的工作区给出明确提示，**而不是静默回落默认值**」。
 * 实测（2026-09-13）：提交 `Z:\不存在的目录\xyz` → 确认返回 **HTTP 200、problems=0**，
 * 静默接受了这个不存在的目录。后果是任务带着一个假路径被建出来，
 * 直到 AI 执行会话启动时才可能暴露，而且用户完全不知道自己填错了。
 *
 * ## 设计取舍
 *
 * - **纯函数式**：`checkWorkspacePath()` 只做判定并返回结构化结果，不抛错、不写库，
 *   便于单测覆盖，也便于不同调用方决定"拒绝 / 警告 / 忽略"。
 * - **不静默回落**：调用方拿到 `ok: false` 后必须把原因告诉用户（草稿确认进 `problems`，
 *   工具调用直接回错误字符串），**绝不**悄悄换成默认工作区。
 * - **WSL ↔ Windows 互转**：用户在 Windows 上可能贴 `/mnt/d/xxx`，在 WSL 里可能贴 `D:\xxx`。
 *   两种形态都要认（与 `openFileRoute.ts` 的互转保持同一口径）。
 */
import { existsSync, statSync, accessSync, constants } from 'node:fs'

export interface WorkspaceCheckResult {
  ok: boolean
  /** 判定为可用时，返回归一化后（可写盘）的路径。 */
  normalized: string | null
  /** `ok: false` 时的人类可读原因（中文，可直接展示给用户）。 */
  reason: string | null
}

/**
 * WSL 形态 → Windows 形态：`/mnt/d/code` → `D:\code`。
 *
 * 只在 Windows 上转换（`process.platform === 'win32'`）；
 * 在 Linux/WSL 内部跑时保持原样，否则会把本来正确的路径改坏。
 */
export function wslToWindows(input: string): string {
  if (process.platform !== 'win32') return input
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(input.trim())
  if (m === null) return input
  const drive = m[1].toUpperCase()
  const rest = (m[2] ?? '').replace(/\//g, '\\')
  return `${drive}:${rest === '' ? '\\' : rest}`
}

/** Windows 形态 → WSL 形态：`D:\code` → `/mnt/d/code`。 */
export function windowsToWsl(input: string): string {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(input.trim())
  if (m === null) return input
  const drive = m[1].toLowerCase()
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

/**
 * 校验工作区路径是否**真实存在且可写**。
 *
 * 判定顺序（每步失败都给出具体原因，而不是笼统的"路径无效"）：
 * 1. 空路径 → 视为"未指定"，`ok: true`（沿用既有行为：不填就用默认值，这不算错误）；
 * 2. 归一化（WSL ↔ Windows）后在**当前平台**与**另一形态**里找一个真实存在的；
 * 3. 存在但不是目录 → 报"不是目录"；
 * 4. 目录不可写 → 报"没有写权限"（`accessSync(W_OK)`；Windows 上权限位语义较弱，
 *    失败时给出提示但仍然算不可写，避免"以为能写其实不能"）。
 */
export function checkWorkspacePath(raw: string | null | undefined): WorkspaceCheckResult {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (input === '') return { ok: true, normalized: null, reason: null }

  // 候选：原样、WSL→Windows、Windows→WSL，去重后按顺序探测。
  const candidates = [...new Set([input, wslToWindows(input), windowsToWsl(input)])]
  let existing: string | null = null
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) { existing = candidate; break }
    } catch { /* 非法路径字符等，继续试下一个形态 */ }
  }
  if (existing === null) {
    return { ok: false, normalized: null, reason: `工作区目录不存在：${input}（请确认路径，或留空使用默认工作区）` }
  }

  try {
    if (!statSync(existing).isDirectory()) {
      return { ok: false, normalized: null, reason: `工作区不是目录：${existing}（请填目录，不要填文件）` }
    }
  } catch (error) {
    return { ok: false, normalized: null, reason: `工作区无法访问：${existing}（${error instanceof Error ? error.message : String(error)}）` }
  }

  try {
    accessSync(existing, constants.W_OK)
  } catch {
    return { ok: false, normalized: null, reason: `工作区没有写权限：${existing}（AI 执行会话将无法在该目录写入）` }
  }

  return { ok: true, normalized: existing, reason: null }
}
