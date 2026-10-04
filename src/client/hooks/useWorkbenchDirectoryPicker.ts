/**
 * D17 / P6-4：**工作区「浏览…」目录选择域（DirectoryPicker）的唯一所有者**。
 *
 * 拆分前它是 `WorkbenchApp` 体内的 5 项 state + `loadDirPickerDir`（原
 * `src/client/index.tsx:307-311` 与 `:464`）。
 *
 * ## 为什么它自成一个域
 * 三个入口（快速录入 / 新建任务 / 编辑任务）共用**同一份弹窗状态**，
 * 只由 `dirPickerTarget` 记"是哪个入口打开的"。所以这里只装"列目录"这件事本身
 * （状态 + 请求 + 两个写口），**"选中后写到哪"仍留在装配层**
 * （入口的 `applyWorkspaceDir` 按 `target` 分流到三个域）—— 那是跨域组合，不是本域的职责。
 *
 * ## 零依赖、零注入
 * 本域不读任何别的域的东西：请求形状由纯模块 `localDirBrowser.ts#localDirRequestUrl`
 * 给出（与知识库那个弹窗**同一实现**，避免哨兵 / 编码口径分叉），
 * 失败写进自己的 `error` 状态，**不往全局 toast 抛** —— 搬迁前就是"弹窗里就地显示可读原因"。
 *
 * ## 刻意不做的事
 * - 不接管 `LocalDocModal` 的渲染（视图仍在入口，本域只给状态与动作）；
 * - 不合并"起始目录"的算法（每个入口的当前值不同，那是装配层用 `openFor(target, start)` 传进来的）；
 * - 不把 `openDirPicker` / `applyWorkspaceDir` 搬进来（前者读三个域的当前值、后者写三个域）。
 */
import { useState } from 'react'
import { api } from '../api.js'
import { localDirRequestUrl } from '../localDirBrowser.js'
import type { LocalDirListing } from '../components/LocalDocModal.js'

/** 弹窗是从哪个入口打开的（决定"选中后写到哪"，由装配层分派）。 */
export type DirectoryPickerTarget = 'quick' | 'form' | 'edit'

export interface UseWorkbenchDirectoryPickerActions {
  /** 打开弹窗：记来源 + 记起始目录 + 立刻列一次（入口按目标域算出 `start` 再传进来）。 */
  openFor: (target: DirectoryPickerTarget, start: string) => void
  /** 列目录（请求形状见 `localDirRequestUrl`）；不传 path 由后端落在默认目录。 */
  loadDirPickerDir: (path?: string | null) => Promise<void>
  /** 关闭弹窗（`target = null` 就是"关着"）。 */
  setDirPickerTarget: (target: DirectoryPickerTarget | null) => void
  /** 地址栏手动改路径（列目录由 `loadDirPickerDir` 负责）。 */
  setDirPickerPath: (path: string) => void
}

export interface UseWorkbenchDirectoryPickerResult {
  dirPickerTarget: DirectoryPickerTarget | null
  dirPickerPath: string
  dirPickerListing: LocalDirListing | null
  dirPickerLoading: boolean
  dirPickerError: string | null
  actions: UseWorkbenchDirectoryPickerActions
}

export function useWorkbenchDirectoryPicker(): UseWorkbenchDirectoryPickerResult {
  const [dirPickerTarget, setDirPickerTarget] = useState<DirectoryPickerTarget | null>(null)
  const [dirPickerPath, setDirPickerPath] = useState('')
  const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)
  const [dirPickerLoading, setDirPickerLoading] = useState(false)
  const [dirPickerError, setDirPickerError] = useState<string | null>(null)

  const loadDirPickerDir = async (path?: string | null): Promise<void> => {
    setDirPickerLoading(true); setDirPickerError(null)
    try {
      const res = await api<LocalDirListing>(localDirRequestUrl(path))
      setDirPickerListing(res)
      setDirPickerPath(res.path)
    } catch (e) {
      setDirPickerError(e instanceof Error ? e.message : String(e))
    } finally {
      setDirPickerLoading(false)
    }
  }

  const openFor = (target: DirectoryPickerTarget, start: string): void => {
    setDirPickerTarget(target)
    setDirPickerPath(start)
    void loadDirPickerDir(start)
  }

  return {
    dirPickerTarget, dirPickerPath, dirPickerListing, dirPickerLoading, dirPickerError,
    actions: { openFor, loadDirPickerDir, setDirPickerTarget, setDirPickerPath },
  }
}
