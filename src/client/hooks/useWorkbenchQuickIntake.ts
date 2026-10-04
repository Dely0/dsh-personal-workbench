/**
 * D17 / P6-2：**快速录入域（QuickIntake）的唯一所有者**。
 *
 * 拆分前这些东西散在 `src/client/index.tsx` 的 `WorkbenchApp` 里：8 项 state
 * （`showQuick` L238 / `quickText` L239 / `quickWorkspace` L247 / `quickWorkspaceTouched` L248 /
 * `quickWorkspaceSource` L255 / `quickFollowFolder` L256 / `quickAttachments` L263 /
 * `quickAttachmentNotice` L264）、2 个 ref（`quickImageInputRef` L265 / `quickAttachmentsRef` L275）、
 * 两个内部写入点（`writeQuickAttachments` / `appendQuickAttachments`）、以及
 * `applyQuickWorkspaceDecision` / `openQuickEntry` / `rememberQuickWorkspace` /
 * `forgetQuickWorkspace` / `addQuickAttachments` / `removeQuickAttachment` /
 * `clearQuickAttachments` 与"卸载时释放 object URL"那条 effect。
 *
 * ## 四条不许动的语义（随原注释一起搬进来）
 * 1. **默认工作区只由用户偏好 + 系统配置决定**（v1.15.2 修的事故）：判定走
 *    `decideQuickWorkspaceDefault()`，输入里**没有任何任务/选中项** —— 修前是
 *    `selected?.task.effectiveWorkspacePath`，于是"执行过任务 A 之后默认值就变成 A 的工作区"。
 * 2. **只有用户真动过的选择才记进「最近手动选择」**（`shouldRememberQuickWorkspace` 的前置闸门
 *    在装配层的提交按钮里，本 hook 只提供被调用的那个动作）。
 * 3. **不收的附件必须说清原因**（`partitionQuickFiles` 的 `rejected`），绝不静默丢弃；
 *    图片的 object URL 在移除 / 用完 / 卸载三处都必须 `revokeObjectURL`。
 * 4. **`written` 与 `state` 的一致性靠构造保证**：`writeQuickAttachments` 是唯一出口，
 *    它用**同一个数组**同时赋值 ref 与 state，所以两者不可能分叉，也不需要"effect 里再同步"。
 *
 * ## 刻意不做的事
 * - **不拥有"提交澄清会话"**（那要读 AI 会话域的技能/角色/模型选择，是跨域组合）：
 *   入口的 `openQuickEntry` 只做两件事 —— 本域的 `openIntake()` 与 AI 会话域的
 *   `resetClarifyPicker()`；提交按钮的 JSX 也留在装配层（它调 `startAISession`）。
 * - **不拥有工作区候选集**（`workspaceChoices`）：那份派生被快速录入 / 新建任务 / 编辑任务
 *   **三个入口**共用，读的是宿主快照（不是 React state），归装配层。
 * - **不拥有目录选择弹窗**（`dirPicker*`，D17/P6-4）：三个入口共用一份弹窗状态，
 *   "选中后写到哪"由入口那一个 sink（`applyWorkspaceDir`）分流。
 * - **`detectWslHost` 以注入形式进来**（不是 import）：它仍是入口尾部的模块级纯函数，
 *   而 hook 不能 import 入口（会成环）。注入的是函数本身，所以下面 `decideQuickWorkspaceDefault`
 *   的实参文本与拆分前**逐字一致**。
 */
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { api } from '../api.js'
import { withSettingsFallback } from '../settingsFallback.js'
import {
  isQuickImageDraft, partitionQuickFiles,
  type QuickAttachmentDraft, type QuickDocumentDraft, type QuickImageDraft,
} from '../quickAttachments.js'
import {
  decideQuickWorkspaceDefault, quickFollowFolderDefault,
  type QuickWorkspaceDefaultDecision, type QuickWorkspaceDefaultSource,
} from '../quickWorkspaceDefault.js'
import { forgetRecentWorkspace, mergeRecentWorkspaces, sameRecentWorkspaces } from '../../shared/quickWorkspaceRecent.js'
import { fileToBase64, newTaskId } from '../intakeHelpers.js'
import type { WorkbenchRuntime } from '../viewTypes.js'
import type { WorkbenchSettings } from '../../shared/contracts.js'

export interface UseWorkbenchQuickIntakeInput {
  runtime: WorkbenchRuntime
  /** 设置域的当前值：默认工作区 / 最近手动选择 / 全局"建资料夹"开关都从这里读。 */
  settings: WorkbenchSettings
  /** 设置域的写口原语（`remember` / `forget` 两个写入点用；服务端回传值经 `withSettingsFallback`）。 */
  setSettings: Dispatch<SetStateAction<WorkbenchSettings>>
  /** 宿主平台探测（挂载在入口尾部的纯函数，注入以避免 hook ↔ 入口成环）。 */
  detectWslHost: (runtime: WorkbenchRuntime) => boolean
  onError: (message: string) => void
}

export interface UseWorkbenchQuickIntakeActions {
  /** 受控输入框：一句话描述任务。 */
  setQuickText: (value: string) => void
  /** 受控勾选：在该工作区下建任务资料夹。 */
  setQuickFollowFolder: (value: boolean) => void
  /**
   * 打开「快速录入」——**本域那一半**：把工作区预填重置成稳定默认值、清空输入、弹窗打开。
   * 角色/技能选择器的复位属 AI 会话域，由装配层在同一次点击里拼上（见 `openQuickEntry`）。
   */
  openIntake: () => void
  /** 收起弹窗（右上角关闭 / 点遮罩）。**不清附件**：与下面的 `cancelIntake` 语义不同。 */
  closeIntake: () => void
  /** 「取消」：先清附件（含 object URL），再收起弹窗。 */
  cancelIntake: () => void
  /**
   * 用户在工作区输入框 / 「浏览…」弹窗里选定了一个目录 —— **唯一**的"用户输入"写点。
   *
   * 两处调用点（`WorkspacePicker.onChange` 与装配层的 `applyWorkspaceDir`）语义相同：
   * 写明"手动改过"并写入路径。收成一个动作是因为拆分前这两处各写了一遍两连 setState。
   */
  overrideWorkspace: (path: string) => void
  rememberQuickWorkspace: (path: string) => Promise<void>
  forgetQuickWorkspace: (path: string) => Promise<void>
  addQuickAttachments: (files: readonly File[]) => void
  removeQuickAttachment: (id: string) => void
  clearQuickAttachments: () => void
}

export interface UseWorkbenchQuickIntakeResult {
  showQuick: boolean
  quickText: string
  quickWorkspace: string
  quickWorkspaceTouched: boolean
  quickWorkspaceSource: QuickWorkspaceDefaultSource
  quickFollowFolder: boolean
  quickAttachments: QuickAttachmentDraft[]
  quickAttachmentNotice: string | null
  /** 隐藏的 `<input type="file">`（「添加附件」按钮点它）。 */
  quickImageInputRef: RefObject<HTMLInputElement>
  actions: UseWorkbenchQuickIntakeActions
}

export function useWorkbenchQuickIntake(input: UseWorkbenchQuickIntakeInput): UseWorkbenchQuickIntakeResult {
  // 注入回调/依赖在函数体第一行改回原名 —— 下面从入口搬过来的函数体因此逐字未改。
  const { runtime, settings, setSettings, detectWslHost, onError: setError } = input

  const [showQuick, setShowQuick] = useState(false)
  const [quickText, setQuickText] = useState('')
  /**
   * 快速录入的工作区选择（v1.14.0）。
   * - `quickWorkspace`：用户最终采用的工作区路径（空 = 交给既有隐式逻辑）。
   * - `quickWorkspaceTouched`：用户是否动过它 —— 决定来源提示显示"默认值"还是"手动指定"。
   * - `quickFollowFolder`：勾选时在所选工作区下建**任务资料夹**（`<任务ID>-<标题片段>`）。
   *   v1.15.1 起不再按标题命名（改标题会留孤儿目录、同名任务会挤同一目录）。
   */
  const [quickWorkspace, setQuickWorkspace] = useState('')
  const [quickWorkspaceTouched, setQuickWorkspaceTouched] = useState(false)
  /**
   * 当前预填值是"从哪来的"（上次手动选择 / 系统默认 / 未设置）。
   *
   * 由 `decideQuickWorkspaceDefault()` 一次性给出，界面只负责显示 ——
   * 界面上再自己判一遍"这算不算继承"就是同一个语义两处实现（本次事故的形态）。
   */
  const [quickWorkspaceSource, setQuickWorkspaceSource] = useState<QuickWorkspaceDefaultSource>('unset')
  const [quickFollowFolder, setQuickFollowFolder] = useState(false)
  /**
   * 快速录入的附件（v1.15.1）：图片走宿主原生多模态管线，PDF/DOCX 先由服务端抽成文本。
   *
   * 一次性放在一个数组里，是因为"张数上限"要**按类型分别算**
   * （图片 10 张、文档 4 份）—— 拆成两个 state 会让上限判定分散到两处。
   */
  const [quickAttachments, setQuickAttachments] = useState<QuickAttachmentDraft[]>([])
  const [quickAttachmentNotice, setQuickAttachmentNotice] = useState<string | null>(null)
  const quickImageInputRef = useRef<HTMLInputElement>(null)
  /**
   * 附件列表的**写穿镜像 ref**：只给"读当前列表"用（上限判定、卸载清理）。
   *
   * 为什么不能直接在卸载清理里 `setQuickAttachments(...)`：那是在已卸载的组件上写状态。
   *
   * ⚠️ 一致性靠**构造**保证，不靠约定：下面三个写入点（`writeQuickAttachments` 唯一出口）
   * 用**同一个数组**同时赋值 ref 与 state，所以两者不可能分叉；
   * 也因此不需要"effect 里再同步一次"这种第二处实现。
   */
  const quickAttachmentsRef = useRef<QuickAttachmentDraft[]>([])
  const writeQuickAttachments = (next: QuickAttachmentDraft[]): void => {
    quickAttachmentsRef.current = next
    setQuickAttachments(next)
  }
  const appendQuickAttachments = (drafts: QuickAttachmentDraft[]): void => {
    writeQuickAttachments([...quickAttachmentsRef.current, ...drafts])
  }

  /**
   * 把一份判定结果投影到工作区那几个状态上（预填路径 / 来源提示 / 是否手动改过 / 建资料夹默认勾选）。
   *
   * 抽出来是因为"打开弹窗"与"不再记住这个目录"都要做**同一件事** ——
   * 两处各写一遍就是本项目最大的 bug 类别（同一个语义两处实现）。
   * 建资料夹的判据走 `quickFollowFolderDefault()`，与判定模块同一处口径。
   */
  const applyDecision = (decided: QuickWorkspaceDefaultDecision, autoCreateTypeFolders: boolean): void => {
    setQuickWorkspace(decided.path)
    setQuickWorkspaceSource(decided.source)
    // 有默认值时显示来源提示；用户改过就切到"手动指定"
    setQuickWorkspaceTouched(false)
    setQuickFollowFolder(quickFollowFolderDefault(decided.path, autoCreateTypeFolders))
  }

  /**
   * 打开「快速录入」并把工作区选择**重置成稳定默认值**。
   *
   * ## ⚠️ 这里曾经被"最近执行过哪个任务"污染（v1.15.2 修）
   *
   * 原实现是 `const inherited = selected?.task.effectiveWorkspacePath ?? ''`，
   * 即**从当前选中的任务派生默认值**。而执行一个任务恰好会留下这个状态：
   * 「AI 执行」只在任务详情里 → 点它之前 `selected` 必然是被执行的任务；
   * `startAISession` 结尾的 `closePanel()` 只收起面板（React 树不卸载）→
   * `selected` 原样留着。于是"执行过任务 A（工作区 X）→ 打开快速录入"
   * 默认工作区就变成了 X（真机复现截图见 `_local-archive/quick-workspace-default/`）。
   *
   * 现在默认值**只**由用户偏好与系统配置决定（`decideQuickWorkspaceDefault`，
   * 纯函数、有判定表单测）：上次手动选过的目录 → 系统默认工作区 → 空。
   * 输入里没有任何任务/选中项，从类型上就再见不到这种污染。
   *
   * 每次打开都重算 —— 用户可能刚改过默认工作区、或刚手动选过别的目录。
   */
  const openIntake = (): void => {
    applyDecision(decideQuickWorkspaceDefault({
      recent: settings.quickWorkspaceRecent,
      defaultWorkspace: settings.defaultWorkspace,
      isWsl: detectWslHost(runtime),
    }), settings.autoCreateTypeFolders)
    setQuickText('')
    setShowQuick(true)
  }

  /** 收起弹窗（不清附件）：右上角关闭与点遮罩走这里。 */
  const closeIntake = (): void => {
    setShowQuick(false)
  }

  /** 「取消」：连附件一起收掉（含 object URL 释放），再关闭。 */
  const cancelIntake = (): void => {
    clearQuickAttachments()
    setShowQuick(false)
  }

  /** 用户在输入框 / 「浏览…」里选定目录：写明"手动改过"并写入路径。 */
  const overrideWorkspace = (path: string): void => {
    setQuickWorkspaceTouched(true)
    setQuickWorkspace(path)
  }

  /**
   * 记住这次用过的工作区（写进设置，最新的排最前）。
   *
   * 合并口径在 `shared/quickWorkspaceRecent.ts`（置顶 + 去重 + 截断），**同一目录再选一次会挪到第一位**
   * —— 修前实现是"已存在就直接 return"，于是"我明明刚选过这个"却仍预填旧的第一条（审查 F5）。
   * 同值不写：算出来和当前完全一样就不发请求（避免无意义写盘与自激回路）。
   * 失败静默：这只是便利功能，不能因为它挡住"创建工作区"这个主流程。
   */
  const rememberQuickWorkspace = async (path: string): Promise<void> => {
    const next = mergeRecentWorkspaces(settings.quickWorkspaceRecent, path)
    if (sameRecentWorkspaces(settings.quickWorkspaceRecent, next)) return
    try {
      const res = await api<{ settings: WorkbenchSettings }>('/api/workbench/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quickWorkspaceRecent: next }),
      })
      setSettings(withSettingsFallback(res.settings))
    } catch { /* 记不住就算了，不影响主流程 */ }
  }

  /**
   * 「不再记住这个目录」——把当前预填（若来自"上次手动选择"）从最近列表里删掉。
   *
   * 为什么必须有（审查 F1）：这个列表是默认值的**唯一来源**，删不掉就意味着
   * "用户在设置里改了默认工作区也永远回不去"。删除后立刻用**服务端回传的权威设置**重算预填，
   * 走的还是同一个 `decideQuickWorkspaceDefault()`，不另写一套。
   *
   * ⚠️ 基准取**服务端当前值**而不是本地快照（fresh-eyes 复审 N1）：服务端是整表替换语义，
   * 拿"弹窗打开那一刻"的旧快照算整表，会把期间别的窗口刚记下的条目一起抹掉。
   * 这一步只把竞争窗口从"弹窗存活期间"缩到"这一两次请求之间"，**不是**并发安全的证明。
   */
  const forgetQuickWorkspace = async (path: string): Promise<void> => {
    try {
      const snapshot = await api<{ settings: WorkbenchSettings }>('/api/workbench/settings')
      const next = forgetRecentWorkspace(snapshot.settings.quickWorkspaceRecent, path)
      const res = await api<{ settings: WorkbenchSettings }>('/api/workbench/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quickWorkspaceRecent: next }),
      })
      setSettings(withSettingsFallback(res.settings))
      /**
       * 后置校验：服务端必须按**提交的整表**落库。
       *
       * 为什么值得写：这条链跨了服务端（旧版本是"合并"语义，会把删掉的又并回来），
       * 而"提交成功但记录还在"是**静默失败** —— 用户以为已经不再记住，下次打开它又回来了。
       * 换成可读错误至少能说清"重启 DSH 后生效"。
       *
       * 它证明的只是"我提交的表被照单落库"，**不覆盖**并发覆盖（那是 false negative 的边界，见复审 N1）。
       */
      if (!sameRecentWorkspaces(res.settings.quickWorkspaceRecent, next)) {
        setError('服务端没有按提交的列表落库：「最近手动选择」里那条记录仍在。宿主若还是旧版本，重启 DSH 后生效。')
      }
      applyDecision(decideQuickWorkspaceDefault({
        recent: res.settings.quickWorkspaceRecent,
        defaultWorkspace: res.settings.defaultWorkspace,
        isWsl: detectWslHost(runtime),
      }), res.settings.autoCreateTypeFolders)
    } catch (e) {
      // 失败必须可观测：否则用户以为已经不再记住，下次打开它又回来了
      setError(`不再记住「${path}」失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * ============================================================
   * 快速录入附件（v1.15.1）
   * ============================================================
   *
   * 三条规矩：
   *
   * 1. **不收的文件要说清原因**（`partitionQuickFiles` 返回 `rejected`），
   *    绝不静默丢弃 —— "拖了 3 个文件只进去 1 个、剩下两个一声不响"是用户最难查的类别；
   * 2. 图片用 `URL.createObjectURL` 做缩略图，移除时**必须 `revokeObjectURL`**（否则内存泄漏）；
   * 3. 文档不在客户端解析：POST 给 `/quick-attachments/extract-text` 抽正文，
   *    失败（超限/损坏/不支持）当场用中文原因回显，并**不把这份文档塞进附件列表**。
   */
  const addQuickAttachments = (files: readonly File[]): void => {
    // 上限判定读 ref（同一 tick 里连续拖两次也要算准），ref 由下面的写入点同步维护。
    const partition = partitionQuickFiles(files, quickAttachmentsRef.current)
    const rejectedText = partition.rejected.map((item) => `${item.name}：${item.reason}`).join('；')
    setQuickAttachmentNotice(rejectedText === '' ? null : rejectedText)
    if (partition.images.length > 0) {
      const drafts: QuickImageDraft[] = partition.images.map((file) => ({
        id: newTaskId(),
        file: file as File,
        previewUrl: URL.createObjectURL(file as File),
      }))
      appendQuickAttachments(drafts)
    }
    if (partition.documents.length > 0) {
      void (async () => {
        for (const file of partition.documents) {
          try {
            const base64 = await fileToBase64(file as File)
            const res = await api<{ ok: boolean; content: string; truncated: boolean; name: string; mediaType: string; size: number }>(
              '/api/workbench/quick-attachments/extract-text',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: file.name, mediaType: file.type, data: base64 }),
              },
            )
            const draft: QuickDocumentDraft = {
              id: newTaskId(),
              name: res.name ?? file.name,
              mediaType: res.mediaType ?? file.type,
              size: res.size ?? file.size ?? 0,
              content: res.content,
              truncated: res.truncated,
            }
            appendQuickAttachments([draft])
          } catch (error) {
            setQuickAttachmentNotice(`${file.name}：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
    }
  }

  /** 移除一份附件；图片要连带释放 object URL。 */
  const removeQuickAttachment = (id: string): void => {
    const target = quickAttachmentsRef.current.find((item) => item.id === id)
    if (target !== undefined && isQuickImageDraft(target)) URL.revokeObjectURL(target.previewUrl)
    writeQuickAttachments(quickAttachmentsRef.current.filter((item) => item.id !== id))
    setQuickAttachmentNotice(null)
  }

  /** 发送成功后清空附件（同样释放 object URL）。 */
  const clearQuickAttachments = (): void => {
    for (const item of quickAttachmentsRef.current) if (isQuickImageDraft(item)) URL.revokeObjectURL(item.previewUrl)
    writeQuickAttachments([])
    setQuickAttachmentNotice(null)
  }

  /** 卸载时释放还没发送的图片 URL（否则每次开关快速录入都会漏一份）。 */
  useEffect(() => () => {
    for (const item of quickAttachmentsRef.current) if (isQuickImageDraft(item)) URL.revokeObjectURL(item.previewUrl)
    quickAttachmentsRef.current = []
  }, [])

  return {
    showQuick, quickText, quickWorkspace, quickWorkspaceTouched, quickWorkspaceSource,
    quickFollowFolder, quickAttachments, quickAttachmentNotice, quickImageInputRef,
    actions: {
      setQuickText, setQuickFollowFolder,
      openIntake, closeIntake, cancelIntake, overrideWorkspace,
      rememberQuickWorkspace, forgetQuickWorkspace,
      addQuickAttachments, removeQuickAttachment, clearQuickAttachments,
    },
  }
}
