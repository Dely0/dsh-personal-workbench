/**
 * 工作区路径纯函数。
 * WSL 下 DSH 使用 /mnt/<drive>/... 的真实路径；用户/任务里可能是 Windows 路径（D:\Code）。
 * 这里只做字符串归一化，与 React/运行时解耦，便于单元测试。
 */

const WINDOWS_DRIVE_RE = /^([A-Za-z]):(?:[\\/](.*))?$/

/**
 * 把 Windows 盘符路径归一化为 WSL 路径：
 * - D:\Code -> /mnt/d/Code（盘符小写，路径保留大小写，反斜杠转正斜杠）
 * - D:/Code -> /mnt/d/Code
 * - 相对路径（Code、./Code、../Code）不转换
 * - 已是 /mnt/... 或其他 Unix 绝对路径不转换
 */
export function normalizeWindowsPathToWsl(input: string): string {
  const path = input.trim()
  if (path === '') return input
  if (path.startsWith('/')) return path
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('~')) return path

  const match = WINDOWS_DRIVE_RE.exec(path)
  if (match === null) return path

  const drive = match[1].toLowerCase()
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  const normalizedRest = rest.replace(/^\/+/, '')
  if (normalizedRest === '') return `/mnt/${drive}`
  return `/mnt/${drive}/${normalizedRest}`
}

/**
 * 拼接工作区基础路径与子文件夹。
 * WSL 下统一使用正斜杠；原生 Windows 下可传反斜杠。
 * 兼容 Windows 盘符前缀（D:\Code + Folder -> D:/Code/Folder，separator='/'）。
 */
export function joinPath(base: string, folder: string, separator: '/' | '\\' = '/'): string {
  const baseClean = base.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\//g, separator)
  const folderClean = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\//g, separator)
  return `${baseClean}${separator}${folderClean}`
}

/**
 * 判断一个主机路径字符串是否属于 POSIX/WSL 风格（以 / 开头且不是 Windows 盘符路径）。
 * 用于在客户端区分 DSH 跑在 WSL（/mnt/...、/home/...）还是原生 Windows（D:\...）。
 */
export function isWslStylePath(input: string): boolean {
  return input.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(input)
}

/**
 * 归一化一个路径用于**比较**：统一分隔符、去掉结尾分隔符、小写。
 *
 * 额外把 Windows 盘符形态也映射成 WSL 形态，并**两个键都参与比较**，
 * 覆盖"宿主跑在 WSL、设置里填的是 `D:\...`"这类混写（本机真实存在）。
 *
 * ⚠️ 这是**路径比较的唯一实现**：工作区筛选（`intakeWorkspace.ts`）与
 * 任务资料夹判定（`taskFolder.ts`）都必须用它，不要在各自模块里再写一套
 * （2026-09-16 fresh-eyes 审查把两处各一份比较逻辑列为"同一个语义两处实现"）。
 */
export function workspacePathKeys(path: string): string[] {
  const trimmed = String(path ?? '').trim()
  if (trimmed === '') return []
  const keys = new Set<string>()
  const add = (value: string): void => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (normalized !== '') keys.add(normalized)
  }
  add(trimmed)
  if (!isWslStylePath(trimmed) && /^[A-Za-z]:[\\/]/.test(trimmed)) add(normalizeWindowsPathToWsl(trimmed))
  return [...keys]
}

/** `path` 是否位于 `root` 之下（含 root 自身）；`root` 为空则恒为 false。 */
export function pathIsUnderRoot(path: string, root: string): boolean {
  const rootKeys = workspacePathKeys(root)
  if (rootKeys.length === 0) return false
  for (const pathKey of workspacePathKeys(path)) {
    for (const rootKey of rootKeys) {
      if (pathKey === rootKey || pathKey.startsWith(`${rootKey}/`)) return true
    }
  }
  return false
}
