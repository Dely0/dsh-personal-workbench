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
