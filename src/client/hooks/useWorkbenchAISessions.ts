/**
 * D17 / P6-3：**AI 会话域（AISessions）的唯一所有者**。
 *
 * 拆分前这些东西散在 `src/client/index.tsx` 的 `WorkbenchApp` 里：12 项 state
 * （`quickModelSelection` / `modelModalityTable` / `promptModal` / `skillCatalog` / `skillsAvailable` /
 * `skillsLoading` / `skillProblem` / `skillQuery` / `selectedSkills` / `promptPersona` /
 * `quickPersona` / `promptModelSelection`）、1 个 ref（`promptResolveRef`），以及
 * `loadSkills` / `askUserPrompt` / `confirmPrompt` / `cancelPrompt` / `toggleSkill` /
 * `AI_PROMPT_LABELS` / `openSessionInPanel` / **`startAISession`（468 行）** / `reuseAiSessionId`。
 *
 * ## 为什么 `startAISession` 必须搬（不是"顺手"）
 * ADR-0008 的结构硬门写着「单个顶层块 ≤80 行」—— 它是整个入口里最长的一个块
 * （快照 `src/client/index.tsx:759–1258`，500 行），无论判据怎么定都属于"不承载长 handler"
 * 的反面典型。搬走它同时解决了另外两件事：`useCallback` 依赖数组再也看不见它，
 * 而它引用的 10 个外部名字全部改成**显式注入**（拆分前靠闭包猜作用域）。
 *
 * ## 不动的东西（刻意）
 * - **`busy` / `setBusy` 不在这里**：它被"AI 会话"与"知识域"共写、被三个视图读，
 *   属 `hooks/useWorkbenchBusy.ts`（P6-1 单独立域），否则 AI hook 要落回 `useKnowledge` 之前。
 * - **`startAISessionRef` 不在 `useWorkbenchAISessions` 内部**：入口里那个"惰性转发 ref"
 *   （`useKnowledge` 在上部就要拿到它）仍归装配层，本 hook 只交出函数本身。
 * - **三个宿主助手以注入形式进来**（与 P6-2 的 `detectWslHost` 同一手法）：
 *   `loadModelModalityTable` / `aiSessionUsable` / `connectWorkspace` 仍是
 *   `src/client/index.tsx` **模块作用域**的函数（入口的两处 `ModelPicker.onLoaded`、
 *   两处 `isSessionUsable` 也要用它们），而 hook 不能 import 入口（会成环）。
 *   注入的是函数本身，所以下面这些调用点的实参文本与拆分前**逐字一致**。
 *
 * ## 不许动的语义（随原注释一起搬进来）
 * 1. **技能目录"空"≠"没有这个能力"**：宿主把"发现失败"静默降级成空目录，
 *    所以空目录必须报成**可恢复故障**（原因 + 重试），不许整块隐藏（v1.15.6）。
 * 2. **三个角色状态位语义不同，不许合并**：共享提示词弹窗与快速录入各一份，
 *    默认 `INHERIT_PERSONA`（不改变既有行为）。
 * 3. **两个弹窗共用同一份模型持久化**（同一个 localStorage 键），所以是两个 state
 *    但共用 `readQuickModelSelection` / `writeQuickModelSelection`。
 * 4. **复用三判据**（登记行还要"会话真的可用"且计划确有当日计划 / 报告行自带的 sessionId /
 *    角色变了就新建）都在 `reuseAiSessionId` 里，一处实现。
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from '../api.js'
import { localDateString } from '../format.js'
import {
  INHERIT_PERSONA, decidePersonaReuse, personaIdToBind,
  type PersonaBindingView, type PersonaSelection,
} from '../personaPicker.js'
import { withPersonaPromptBlock } from '../personaPrompt.js'
import { withSkillPromptBlock } from '../skillPrompt.js'
import { newTaskId, quickImageToPromptPart } from '../intakeHelpers.js'
import { readQuickModelSelection, writeQuickModelSelection } from '../components/ModelPicker.js'
import {
  buildQuickIntakePrompt, isQuickImageDraft,
  type QuickAttachmentDraft, type QuickDocumentDraft,
} from '../quickAttachments.js'
import {
  classifyTaskWorkspacePath, isAutoTaskWorkspacePath, taskWorkspaceFolderName,
} from '../taskFolder.js'
import { pickIntakeWorkspace, readCreatedWorkspaceId } from '../intakeWorkspace.js'
import { acquireSession, openSessionInMainView, type SessionReference } from '../sessionRef.js'
import { currentSessionIdOf, safeService } from '../runtimeServices.js'
import { resolveModelDirectoryOutcomeFor } from '../components/ModelPicker.js'
import {
  effectiveModelLabel, effectiveSelection, evaluateImageSupport, selectionToApply,
  type SelectionApplication,
} from '../modelCapability.js'
import { isWslStylePath, joinPath, normalizeWindowsPathToWsl } from '../workspacePath.js'
import type { PlanPromptPayload } from '../dailyPlanPrompt.js'
import type {
  DraftView, SkillSummary, SkillsResponse, WorkbenchSettings,
} from '../../shared/contracts.js'
import type {
  DailyPlanView, Dict, Idea, IdeaClusterView, PromptContentPart, QuickModelSelection,
  Task, WorkbenchRuntime,
} from '../viewTypes.js'

/** `startAISession` 的签名（与 `useKnowledge.ts#StartAISessionFn` 结构一致，靠结构化赋值对接）。 */
export type StartAISessionAction = (
  mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc',
  task: Task | null,
  text: string,
  previousSessions?: Array<Record<string, unknown>>,
  docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean },
  workspaceOverride?: string,
  clarifyOptions?: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection },
) => Promise<void>

export interface UseWorkbenchAISessionsInput {
  runtime: WorkbenchRuntime
  /** 收面板（`WorkbenchApp` 的 prop）：会话开成功之后才收，顺序反了就成了"点了没反应"。 */
  closePanel: () => void
  /** 设置域当前值：默认工作区 / 「建任务资料夹」开关 / 默认耗时都从这里读。 */
  settings: WorkbenchSettings
  /** 任务域的字典只读派生：`idea_brainstorm` 提示词要把"类型"字典列给模型。 */
  dicts: Dict[]
  /** 点子域只读快照：`idea_association` / `idea_brainstorm` 用它按 id 取点子。 */
  ideasAll: Idea[]
  /** 日期域的计划提示词构造器（**唯一实现在 `dailyPlanPrompt.ts`**）。 */
  planPromptFor: (planDate: string) => PlanPromptPayload
  todayPlan: DailyPlanView | null
  pickedPlan: DailyPlanView | null
  /** 草稿域的待确认草稿：`plan` 复用时要求"确有当日计划或待确认草稿"。 */
  pendingDraft: DraftView | null
  /** 快速录入域：澄清会话发送成功之后把附件清掉。 */
  clearQuickAttachments: () => void
  /** 快速录入域：`clarify` 命中复用会话时关掉录入窗（语义与 `closeIntake` 完全一致）。 */
  closeIntake: () => void
  /** `let instanceAlive` 的**实时**读数（模块作用域，卸载后为 false）：await 之后每处都要看它一眼。 */
  isAlive: () => boolean
  setError: (message: string | null) => void
  setBusy: (value: boolean) => void
  /** 模块级宿主助手（见文件头：注入以避免 hook ↔ 入口成环）。 */
  loadModelModalityTable: () => Promise<ReadonlyMap<string, readonly string[] | null>>
  aiSessionUsable: (runtime: WorkbenchRuntime, sessionId: string) => boolean
  connectWorkspace: (workspaceId: string) => Promise<string>
}

export interface UseWorkbenchAISessionsActions {
  /** 受控选择器：快速录入弹窗的模型选择（写 localStorage —— 两个弹窗同一份持久化）。 */
  setQuickModelSelection: (selection: QuickModelSelection | null) => void
  /** 受控选择器：共享提示词弹窗的模型选择（与上面共用同一份持久化）。 */
  setPromptModelSelection: (selection: QuickModelSelection | null) => void
  setModelModalityTable: Dispatch<SetStateAction<ReadonlyMap<string, readonly string[] | null>>>
  /** 共享提示词弹窗的输入内容（`ModelPicker` 的受控值）。 */
  setPromptModal: Dispatch<SetStateAction<{ title: string; value: string } | null>>
  setPromptPersona: Dispatch<SetStateAction<PersonaSelection>>
  setQuickPersona: Dispatch<SetStateAction<PersonaSelection>>
  /** 技能目录装载（`useCallback(…, [])`：三处 `onRetry` 与两个弹窗打开时共用同一份身份）。 */
  loadSkills: () => Promise<void>
  confirmPrompt: () => void
  cancelPrompt: () => void
  toggleSkill: (name: string) => void
  openSessionInPanel: (sessionId: string) => void
  startAISession: StartAISessionAction
  /**
   * 澄清入口每次打开时的复位（**跨域组合留装配层**）：角色回「未指定」+
   * 清空技能选择 + 重拉技能目录。三件事必须同批做，否则"上一次的选择静默成为这一次的"。
   */
  resetClarifyPicker: () => void
}

export interface UseWorkbenchAISessionsResult {
  quickModelSelection: QuickModelSelection | null
  modelModalityTable: ReadonlyMap<string, readonly string[] | null>
  promptModal: { title: string; value: string } | null
  skillCatalog: SkillSummary[]
  skillsAvailable: boolean
  skillsLoading: boolean
  skillProblem: string
  skillQuery: string
  selectedSkills: string[]
  promptPersona: PersonaSelection
  quickPersona: PersonaSelection
  promptModelSelection: QuickModelSelection | null
  actions: UseWorkbenchAISessionsActions
}

export function useWorkbenchAISessions(input: UseWorkbenchAISessionsInput): UseWorkbenchAISessionsResult {
  /**
   * 入参别名（逐字沿用拆分前入口里的局部名）：搬过来的函数体因此**一行都不用改**，
   * 也保证"哪个名字来自哪个域"在函数体里一眼可见。
   */
  const {
    runtime, closePanel, settings, dicts, ideasAll,
    planPromptFor, todayPlan, pickedPlan, pendingDraft,
    clearQuickAttachments, closeIntake, isAlive, setError, setBusy,
    loadModelModalityTable, aiSessionUsable, connectWorkspace,
  } = input

  /**
   * 快速录入澄清会话使用的模型（v1.15.1）。
   *
   * 选择值随会话一起应用（`directory.select`），**不写进任务字段** ——
   * 模型是"这次会话怎么跑"，不是任务属性。
   */
  const [quickModelSelection, setQuickModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())
  const setQuickModelSelection = (selection: QuickModelSelection | null): void => {
    setQuickModelSelectionState(selection)
    writeQuickModelSelection(selection)
  }
  /**
   * 模型 → 输入能力对照表（v1.15.1）。
   *
   * 浏览器侧的模型目录**没有** `inputModalities`（宿主没暴露），
   * 所以从 `/api/workbench/model-modalities` 拉一份**只含能力**的对照表，
   * 用来在发送前判断"选了不收图的模型还加了图"。拉不到就是空表 → 不拦（fail open）。
   */
  const [modelModalityTable, setModelModalityTable] = useState<ReadonlyMap<string, readonly string[] | null>>(() => new Map())

  const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)
  const promptResolveRef = useRef<((value: { text: string; skills: string[]; persona: PersonaSelection } | null) => void) | null>(null)
  // AI 会话前的 Skill 选择器：列表来自宿主 skills 注册表（未安装时 available=false，选择器隐藏）
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([])
  const [skillsAvailable, setSkillsAvailable] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  /**
   * 技能目录**这一次没能给出列表**时的可读原因（`''` = 没有故障，选择器按"不可用就隐藏"处理）。
   *
   * ## 为什么要把它和 `skillsAvailable` 分开（v1.15.6，2026-09-27 用户反馈）
   *
   * 用户现象：昨天还在的「加载 Skill」整块，今天打开提示词弹窗**什么都没有**，
   * 过一会儿（或重开一次）又自己回来了。真因不在本插件，而在宿主的技能注册表：
   * `SkillRegistry.list()` 对 provider 的失败是 `catch → cacheable=false → 记一条 warn`
   * 然后**照常返回剩下的（可能是空的）列表** —— 也就是"技能发现超时/未就绪"这类故障
   * 会被静默降级成"本机没有技能"。而插件把"空目录"和"宿主没装 skills 服务"当成同一件事，
   * 一律**整块隐藏**，于是故障看起来像"功能被删了"，且没有任何恢复入口。
   *
   * 现在的分工：
   * - 宿主**根本没装** skills 服务（`available:false` 且没有 error）→ 仍然隐藏（永久状态，干净界面）；
   * - 服务在、但这次是空目录 / 请求失败 → **显示原因 + 「重试」**，用户能自己恢复，
   *   也能一眼看出"是宿主技能来源没就绪"，而不是以为插件坏了。
   */
  const [skillProblem, setSkillProblem] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  /**
   * 角色选择（D13-B / §6.3）：三个状态位分开存，**语义不同不能合并**。
   *
   * - 共享提示词弹窗（9 个 mode）与快速录入弹窗（clarify）各有一份；
   * - 默认值都是 `INHERIT_PERSONA`（未指定）= **不改变既有行为**；
   * - 复用型会话拿到既有绑定后再由 `decidePersonaReuse()` 判"沿用还是新建会话"。
   */
  const [promptPersona, setPromptPersona] = useState<PersonaSelection>(INHERIT_PERSONA)
  const [quickPersona, setQuickPersona] = useState<PersonaSelection>(INHERIT_PERSONA)
  /**
   * 共享提示词弹窗里的模型选择（2026-10-01）。
   *
   * 与快速录入**同一份持久化**（`writeQuickModelSelection` → 同一个 localStorage 键）：
   * "我这次用哪个模型"是同一件事，存两处必然出现"这个入口选完、那个入口还是旧的"。
   * 所以在两个弹窗之间它是同一份状态读写，只有 UI 挂载点不同。
   */
  const [promptModelSelection, setPromptModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())
  const setPromptModelSelection = (selection: QuickModelSelection | null): void => {
    setPromptModelSelectionState(selection)
    writeQuickModelSelection(selection)
  }

  /**
   * 技能目录：打开提示词弹窗时按需拉取一次。
   *
   * ⚠️ **失败不再静默降级成"隐藏"**（v1.15.6）：宿主那侧"技能来源发现失败"会被它自己
   * 吞掉并返回空目录，所以这里必须把"空目录"当成**可恢复的故障**报出来（原因 + 重试），
   * 否则用户看到的是"功能不见了"（2026-09-27 实测）。只有"宿主没有 skills 服务"才是
   * 真的没有这个能力，那时选择器整块不渲染。
   */
  const loadSkills = useCallback(async (): Promise<void> => {
    setSkillsLoading(true)
    try {
      const res = await api<SkillsResponse>('/api/workbench/skills')
      setSkillCatalog(res.skills)
      if (res.available && res.skills.length > 0) {
        setSkillsAvailable(true)
        setSkillProblem('')
      } else {
        setSkillsAvailable(false)
        setSkillProblem(res.available
          ? '技能目录这次是空的 —— 宿主某个技能来源可能还在初始化，或刚刚发现失败。稍后点「重试」即可。'
          : typeof res.error === 'string' && res.error !== ''
            ? `技能目录读取失败：${res.error}`
            : '')
      }
    } catch (error) {
      setSkillCatalog([]); setSkillsAvailable(false)
      setSkillProblem(`技能目录请求失败：${error instanceof Error ? error.message : String(error)}。服务可能正在重启，点「重试」即可。`)
    } finally { setSkillsLoading(false) }
  }, [])

  /**
   * 共享提示词弹窗（9 个 mode 的**同一入口**）。
   *
   * 返回值里带上用户选的角色（`persona`）：默认 `INHERIT_PERSONA`（未指定），
   * 于是"没动选择器"与"明确选了无角色"在**类型上**就是两件事 ——
   * 复用分流（`decidePersonaReuse`）与"是否新建会话"全靠这个区分（AX-R08）。
   */
  const askUserPrompt = (title: string): Promise<{ text: string; skills: string[]; persona: PersonaSelection } | null> => new Promise((resolve) => {
    promptResolveRef.current = resolve
    setPromptModal({ title, value: '' })
    setSkillQuery('')
    setSelectedSkills([])
    setPromptPersona(INHERIT_PERSONA)
    void loadSkills()
  })
  const confirmPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    const value = promptModal?.value ?? ''
    const skills = [...selectedSkills]
    const persona = promptPersona
    setPromptModal(null)
    resolve?.({ text: value, skills, persona })
  }
  const cancelPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    setPromptModal(null)
    resolve?.(null)
  }
  const toggleSkill = (name: string): void => {
    setSelectedSkills((prev) => prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name])
  }
  const AI_PROMPT_LABELS: Record<string, string> = {
    plan: 'AI 智能排序 / 今日计划',
    consult: 'AI 咨询',
    breakdown: 'AI 拆解',
    execute: 'AI 执行',
    review: 'AI 复盘',
    report: 'AI 日报 / 周报',
    idea_association: 'AI 点子关联',
    idea_brainstorm: 'AI 点子头脑风暴',
    knowledge_doc: 'AI 总结本地文档',
  }
  /**
   * 把主视图切到某个会话（**面板里唯一的入口**）。
   *
   * 为什么收成一个函数：这个语义原先在 4 处各写一遍 `safeService(...,'sessions')?.open(id)`
   * —— 而 DSH 0.1.7-rc.2 把 `sessions.open` **整个移除了**（改由
   * `uiWorkspace.openSession` 承担），于是 4 处一起报 `?.open is not a function`。
   * 现在统一走 `openSessionInMainView()`（见 `sessionRef.ts`），这里只管界面两件事：
   * 成功就收面板、失败就给出可读原因（绝不静默什么都不发生）。
   */
  const openSessionInPanel = (sessionId: string): void => {
    try {
      openSessionInMainView(runtime, sessionId)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return
    }
    closePanel()
  }
  /**
   * 启动 AI 会话。
   *
   * `workspaceOverride`（v1.14.0）来自「快速录入 / 澄清」弹窗里用户**显式选择**的工作区：
   * 之前用户在录入那一刻无法指定工作区，只能接受"父任务继承 → 否则默认工作区 +
   * 按标题建子文件夹"这套隐式规则。传了覆盖值就**逐字使用**它（含不建子文件夹），
   * 不传则行为与改动前完全一致（零回归）。
   *
   * `clarifyOptions`（v1.15.1）只服务于澄清流程：
   * 图片/文档附件，以及"用户选了目录、还勾了建任务资料夹"这一种组合 ——
   * 资料夹名由 `startAISession` 用**预留的任务 ID** 现算（调用方拿不到那个 ID）。
   */
  const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = [], docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean }, workspaceOverride?: string, clarifyOptions: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection } = {}): Promise<void> => {
    const attachments = clarifyOptions.attachments ?? []
    if (mode === 'clarify' && text.trim() === '' && attachments.length === 0) return
    /**
     * 澄清会话由自然语言快速录入直接触发，不弹提示词弹窗；但**角色选择照旧有**：
     * 快速录入弹窗里有同一个 `PersonaPicker`，选择经 `clarifyOptions.persona` 传进来
     * （需求 §6.3：快速录入与共享提示词弹窗同一选择逻辑；AX-R07：10 个 mode 都有角色入口）。
     */
    /**
     * 澄清（快速录入）走本地对象，其余 mode 都走共享提示词弹窗。
     *
     * ⚠️ **`skills` 必须是用户真选的那个数组**（2026-10-01 修）。旧写法在这里硬编码
     * `skills: []`，而 `skillNames = promptInput.skills` 是唯一喂给
     * `withSkillPromptBlock()` 的输入 —— 于是快速录入**即使加了技能选择器也永远不生效**
     * （选了等于没选）。用户反馈"快速录入无法选择 Skill"其实是两层：UI 没有 + 这里恒空。
     *
     * 技能目录由 `askUserPrompt` 与快速录入弹窗各自在打开时 `loadSkills()` 加载，
     * 但**选择结果 `selectedSkills` 是同一份 state** —— 所以这里直接读它。
     */
    const promptInput = mode === 'clarify'
      ? { text: '', skills: [...selectedSkills], persona: clarifyOptions.persona ?? INHERIT_PERSONA }
      : await askUserPrompt(AI_PROMPT_LABELS[mode] ?? 'AI 会话')
    if (promptInput === null) return
    const customPrompt = promptInput.text
    const skillNames = promptInput.skills
    const personaChoice = promptInput.persona ?? INHERIT_PERSONA
    /** 本次新建会话要绑定的角色 id（`''` = 不绑定）。提前算出来：会话标题也要带上它。 */
    const personaId = personaIdToBind(personaChoice)
    const planAnchor = mode === 'plan' ? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDateString()) : ''
    setBusy(true); setError(null)
    /**
     * 新建路径要 acquire 会话引用（DSH 0.1.7-rc.2 的 `sessions.retain`），
     * 引用由下面**唯一**的 finally 释放 —— 所以新建路径里不要再写裸 `return`
     * （宿主按引用计数回收会话 scope，漏释放 = 那个会话与它的窗口永不回收）。
     * 复用路径不 acquire，走早退守卫即可。
     */
    let sessionRef: SessionReference | undefined
    try {
      // 复用型会话：计划/报告/点子关联/点子头脑风暴，每个 scope+anchor 只有一个会话。
      /**
       * 复用判定已抽成 `reuseAiSessionId`（见本组件下方那个函数）：命中已有会话 → 立刻 return；
       * 返回 `kind:'new'` → 落到下面的新建流程。
       *
       * ⚠️ **角色选择参与这个判定**（AX-R08）：用户明确选了与既有绑定不同的角色时，
       * 这里必须**不复用**而是新建会话 —— 旧实现无条件早退，会把用户的选择整个吞掉。
       * 复用路径**不 acquire 会话引用**（复用的是已存在的会话，不新建 scope）。
       */
      const reuse = await reuseAiSessionId(mode, text, planAnchor, personaChoice)
      if (reuse.kind === 'reuse') {
        // 先开会话再关面板（关面板会卸载本面板的 React 树，顺序反了就"点了没反应"）
        openSessionInPanel(reuse.sessionId)
        return
      }
      /**
       * "换了角色 → 新建会话"必须**显式告知**（需求 §6.3）。
       *
       * ⚠️ 不能用 toast：这条路径结尾会 `openSessionInPanel()` 收掉面板，toast 随面板一起不可见。
       * 所以告知走两个**用户真的看得到**的地方：控制台一条 warn + 新会话标题里的角色后缀。
       */
      if (reuse.notice !== '') console.warn(`[workbench] ${reuse.notice}`)
      const ws = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.() ?? { items: [] }
      /**
       * ⚠️ 与 `detectWslHost` 同一个坑（v1.14.50 一起修）：
       * `?.generation.getSnapshot()` 只保护了外层，`generation` 在低版本宿主上不存在 →
       * 直接抛 `TypeError: … reading 'getSnapshot'`。
       * 这里在**创建 AI 会话的主流程**上，抛错会让"发起澄清/执行"整条链路失败。
       */
      const hostHome = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')?.generation?.getSnapshot?.()?.host?.home
      const isWsl = hostHome !== undefined
        ? isWslStylePath(hostHome)
        : ws.items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
      const pathSep = isWsl ? '/' : '\\'
      const explicitWorkspace = workspaceOverride?.trim() ?? ''

      /**
       * ============================================================
       * 任务资料夹（v1.15.1，吸收 fork 的 3.1 节）
       * ============================================================
       *
       * 口径变了三件事：
       *
       * 1. **文件夹名 = `<任务ID>-<标题片段>`**（旧口径是"按标题"）—— 改标题不再产生孤儿目录、
       *    同名任务不再挤同一目录，判定只看 ID 前缀；
       * 2. **澄清阶段先预留任务 ID**，用它建资料夹并写进提示词，
       *    确认草稿时复用同一个 id（`submitTaskTool` 的 `task_id`）——
       *    于是彻底删掉"按用户原话建文件夹"这条分支（`folderForText(text)` 等于把一句话当目录名）；
       * 3. **不再为每个任务注册 AI 工作区**（任务一多，宿主的**工作区列表会被撑爆**）。
       *    会话用**当前工作区**，任务资料夹只在提示词里声明。
       *
       * `classifyTaskWorkspacePath` 是"这条路径算不算自动生成"的**唯一权威判定**
       * （见 `taskFolder.ts`）：只有自动路径允许被回写/迁移，用户手填的**永不触碰**。
       */
      const reservedTaskId = mode === 'clarify' ? newTaskId() : (task?.id ?? '')
      const clarifyText = text.trim()
      let taskFolderPath = ''
      let taskFolderRelative = ''
      if (mode === 'clarify') {
        // 用户显式选了目录且勾了"建任务资料夹"时用所选目录，否则用默认根目录。
        const root = explicitWorkspace !== ''
          ? (clarifyOptions.followFolder === true ? explicitWorkspace : '')
          : (settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders ? settings.defaultWorkspace : '')
        if (root !== '' && reservedTaskId !== '') {
          taskFolderRelative = taskWorkspaceFolderName(reservedTaskId, clarifyText)
          const raw = joinPath(root, taskFolderRelative, pathSep)
          taskFolderPath = isWsl ? normalizeWindowsPathToWsl(raw) : raw
        }
      } else if (task !== null) {
        /**
         * ⚠️ 判定必须带上 `tasksRoot`（fresh-eyes 审查 F2）：
         * "标题型"老路径与"用户手填了一个叫 `<任务标题>` 的目录"在字符串上无法区分，
         * 只有"位于默认根目录之下"这条位置旁证能把两者分开。不带根目录 → 一律 manual（fail-safe）。
         */
        const manual = (task.effectiveWorkspacePath ?? '') !== ''
          && classifyTaskWorkspacePath(task.effectiveWorkspacePath ?? '', task.id, task.title, { tasksRoot: settings.defaultWorkspace }) === 'manual'
        if (manual) {
          // 用户手填的真实项目目录：**这里就是**任务的工作目录，不再往里套一层资料夹。
          taskFolderPath = task.effectiveWorkspacePath ?? ''
        } else {
          const own = task.workspacePath ?? ''
          if (own !== '' && isAutoTaskWorkspacePath(own, task.id, task.title, { tasksRoot: settings.defaultWorkspace })) {
            // 已经是自动生成的任务资料夹（ID 型或老标题型）：沿用它，不另建。
            taskFolderPath = own
          } else if (own === '' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
            const relative = taskWorkspaceFolderName(task.id, task.title)
            const raw = joinPath(task.effectiveWorkspacePath ?? settings.defaultWorkspace, relative, pathSep)
            taskFolderPath = isWsl ? normalizeWindowsPathToWsl(raw) : raw
            taskFolderRelative = relative
          }
        }
      }
      // 资料夹先建出来（`/workspaces/ensure` 实际只做 mkdir），否则草稿确认时的
      // `checkWorkspacePath` 会因为"目录不存在"把整条链路拦掉。
      if (taskFolderPath !== '') {
        try {
          await api('/api/workbench/workspaces/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: taskFolderPath }) })
          // 任务自身和祖先都没有工作区时把解析出的资料夹回写，后续会话都进同一目录。
          if (task !== null && task.workspacePath === null && task.effectiveWorkspacePath === null) {
            void api(`/api/workbench/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspacePath: taskFolderPath }) }).catch(() => undefined)
          }
        } catch { /* 资料夹建不出来不阻断会话：提示词里仍会声明它，AI 可自行创建 */ }
      }

      /**
       * ============================================================
       * 会话挂在哪个工作区（修 `ws.items[0]` 那个真 bug）
       * ============================================================
       *
       * 原写法 `let workspaceId = ws.items[0]?.workspaceId` 是"**随手取第一个工作区**"：
       * 当任务没路径、默认工作区也为空时，会话会挂到一个与用户当前连接**完全无关**的工作区上
       * （最坏情况是另一个任务自动生成的资料夹，于是本次的文件全落进了别人的任务目录）。
       *
       * 现在的判据（`pickIntakeWorkspace`，纯函数、有单测）：
       *
       * 1. 用户**显式**选的工作区 → 用它（建不出来必须报错，不能静默换一个）；
       * 2. 任务有**手填**的真实项目目录 → 连到那儿（"AI 执行"必须在项目里才有意义）；
       * 3. 否则 → 当前会话 cwd 命中的工作区 / 唯一的候选 / **明确拒绝**（绝不猜）。
       *
       * **自动生成的任务资料夹不再注册成 AI 工作区** —— 这正是"工作区列表被任务撑爆"的根源。
       */
      const manualTaskWorkspace = mode !== 'clarify' && task !== null
        && (task.effectiveWorkspacePath ?? '') !== ''
        && classifyTaskWorkspacePath(task.effectiveWorkspacePath ?? '', task.id, task.title, { tasksRoot: settings.defaultWorkspace }) === 'manual'
        ? (task.effectiveWorkspacePath ?? '')
        : ''
      const connectTarget = explicitWorkspace !== '' ? explicitWorkspace : manualTaskWorkspace
      let workspaceId: string | undefined
      if (connectTarget !== '') {
        const normalizedTarget = isWsl ? normalizeWindowsPathToWsl(connectTarget) : connectTarget
        try {
          await api('/api/workbench/workspaces/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: normalizedTarget }) })
          const created = await safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.create?.({ path: normalizedTarget })
          /**
           * ⚠️ 宿主返回的形态**两版都是"拆过包"的 `WorkspaceView`**（顶层就有 `workspaceId`）：
           *
           * - 服务面 `ctx.workspaces.create()`：内部 `const r = await model.create(...); if (r.ok) return r.value.workspace`，
           *   所以成功时**直接给 workspace 对象**（失败是抛 `WorkspaceCreateError`，不是返回 `{ok:false}`）；
           * - 未经服务面的 Remote 原始结果才是 `{ok, value:{workspace}}`。
           *
           * 判据的唯一实现在 `intakeWorkspace.ts#readCreatedWorkspaceId`（两种形态都认，有单测）。
           * 2026-09-27 更正：v1.15.5 的注释曾把"服务面"写成"Remote 原始结果"，
           * 结论（读不到就报错、绝不静默回落）不变，但**那句"旧代码读的字段从不存在"是错的**。
           */
          const createdId = readCreatedWorkspaceId(created)
          if (createdId !== undefined) workspaceId = createdId
          else if (explicitWorkspace !== '') {
            /**
             * 用户**显式**选了工作区、宿主也返回了成功结果，却读不出 id —— 这时**必须报错**：
             * 静默落回"猜一个"会让他以为目录选好了，文件却建到别处（v1.14.0 验收标准之一）。
             */
            throw new Error(`工作区「${normalizedTarget}」已创建但宿主没有返回可用的 id，无法把会话挂到该目录。请改用默认工作区，或把这条现象反馈给插件作者。`)
          }
        } catch (workspaceError) {
          // 用户**显式**选的工作区建不出来时必须报错，不能静默回落其它工作区
          // ——否则用户以为自己选好了，会话却开在别的目录里（v1.14.0 验收标准之一）。
          if (explicitWorkspace !== '') {
            throw new Error(`工作区「${normalizedTarget}」不可用（${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}）。请检查路径是否存在、是否可写，或改回默认工作区。`)
          }
        }
      }
      if (workspaceId === undefined) {
        /**
         * 第 1 档判据要的是"**当前会话**的 cwd"。
         *
         * ⚠️ 这里原先直接读 `sessions.list.getSnapshot().current`，而 0.1.7-rc.2 已经删掉了
         * 这个字段 → `currentCwd` 恒为空 → 第 1 档静默失效 → 工作区多于一个候选时
         * 必然走到下面的"无法确定"，而提示里让用户"切到目标任务所在的工作区"根本救不回来。
         * 现在统一走 `currentSessionIdOf()`（判据与新旧宿主两端都在 `currentSession.ts`）。
         */
        const sessionsState = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list?.getSnapshot?.()
        const currentSessionId = currentSessionIdOf(runtime)
        const currentSession = currentSessionId !== ''
          ? sessionsState?.byId?.[currentSessionId]
          : undefined
        const verdict = pickIntakeWorkspace({
          items: ws.items,
          currentCwd: typeof currentSession?.cwd === 'string' ? currentSession.cwd : '',
          tasksRoot: settings.defaultWorkspace,
        })
        if (!verdict.ok) throw new Error(verdict.reason)
        workspaceId = verdict.workspaceId
      }
      const id = await connectWorkspace(workspaceId)
      // 死上下文防护：`connectWorkspace` 里有 await，期间插件可能已被卸载/重载，
      // 此时读 sessions 会抛 "inactive context"（用户控制台实测的主要报错来源）。
      const sessions = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')
      /**
       * ⚠️ 必须先 retain 再借绑定（DSH 0.1.7-rc.2 起）。
       *
       * rc2 把 `binding(id)` 的判据收成了"**只查已被 retain 的 scope**"，
       * 而 `connectWorkspace()` 内部只是 `sessions.create()`：**谁都没 retain** →
       * `binding(id)` 恒 undefined → 用户点「快速录入」看到"会话绑定未就绪"。
       * 旧宿主没有 `retain`，`acquireSession` 会自动退到 `binding(id)`。
       * 引用由函数尾唯一的 finally 释放（宿主按引用计数回收 scope）。
       */
      sessionRef = await acquireSession(sessions, id)
      /**
       * 把用户选的模型应用上去（**必须在 prompt 之前**）：`select()` 走宿主持久投影，
       * 下一次请求就是它。
       *
       * ## 口径（2026-09-28 死锁事故后修订，用户已确认 A + B）
       *
       * - **拿到目录** → 照旧应用用户选的模型。应用失败仍然**不静默吞掉**：
       *   `directory.select()` 抛出的可读原因原样上抛（既有设计意图保留）。
       * - **拿不到目录** → **不中断**这条流程：忽略那条残留选择、按
       *   「跟随 DSH 默认模型」跑完，并给一条明确说"本次未切换模型"的提示。
       *
       * ⚠️ 旧实现在这里**直接 `throw`**，于是一个可选增强（另一个客户端插件提供的
       * 下拉框）把整条流程拖死 —— 用户看到的是"选过模型之后快速录入整个不可用"。
       * 判定收敛到纯函数 `selectionToApply()`，本处只负责"照判定做事 + 留痕"。
       *
       * ⚠️ **`mode === 'clarify'` 的门禁已拆（2026-10-01）**：原先只有澄清会应用模型选择，
       * 于是给 9 个走共享提示词弹窗的 mode 补上模型选择器也**不会生效**（选了被静默忽略，
       * 比"没有下拉框"更糟）。现在所有 mode 都走同一条应用路径。
       */
      const modelSelection = mode === 'clarify' ? quickModelSelection : promptModelSelection
      let selectionApplication: SelectionApplication = { kind: 'follow-default', notice: '' }
      {
        const outcome = resolveModelDirectoryOutcomeFor(runtime, id)
        /**
         * ⚠️ 提交时的 `clearExitReachable` **按"出口本身是否依赖目录"来判**，不是按当时菜单的开合：
         * 清空出口从来不依赖模型目录（`clearQuickModelSelection` 只是返回 `null`），
         * 所以只要用户手里还有一条残留选择，提示里就可以让他去点那个出口。
         * 没有残留选择时不必提（那时也没有东西可清）。
         */
        selectionApplication = selectionToApply(modelSelection, outcome, {
          clearExitReachable: modelSelection !== null,
        })
        if (selectionApplication.kind === 'apply') {
          if (outcome.ok) {
            await outcome.directory.load()
            await outcome.directory.select(selectionApplication.selection)
          }
        } else if (selectionApplication.notice !== '') {
          console.warn(`[workbench] 未切换模型（降级为默认）：${selectionApplication.notice}`)
          setError(selectionApplication.notice)
        }
      }
      /**
       * 附件里的图片：先判断"选中的模型收不收图"。
       *
       * 宿主在模型声明了 `inputModalities` 且不含 `image` 时，会把图片块**静默**换成
       * 一行 `[image omitted because this model accepts text only; …]` ——
       * 用户看到的是"我传了截图，AI 却说没看到"。所以这里在**发送前**给可读提示
       * （`evaluateImageSupport` 的判据与宿主逐条对齐，判不出来时不拦）。
       *
       * ⚠️ 判定用的模型必须与**本次真的会生效的那个**一致：降级时本地还留着上次选的
       * 模型名，照旧拿它去判会得到"这个模型不收图"的假告警（或漏掉真告警）。
       */
      const imageDrafts = attachments.filter(isQuickImageDraft)
      if (mode === 'clarify' && imageDrafts.length > 0) {
        const outcome = resolveModelDirectoryOutcomeFor(runtime, id)
        /**
         * 每次带图发送都**现拉一次**对照表：它只有几十行、来自宿主内存里的配置，
         * 而缓存住会让"用户在设置里换了模型目录"之后判断长期失准。
         */
        const current = outcome.ok ? outcome.directory.store.getSnapshot().current : null
        const chosen = selectionApplication.kind === 'apply'
          ? selectionApplication.selection
          : effectiveSelection(null, current)
        const verdict = evaluateImageSupport(await loadModelModalityTable(), chosen?.provider ?? '', chosen?.model ?? '')
        if (verdict.kind === 'rejected') throw new Error(verdict.reason)
      }
      const imageParts: PromptContentPart[] = mode === 'clarify' && imageDrafts.length > 0
        ? await Promise.all(imageDrafts.map(quickImageToPromptPart))
        : []
      /**
       * 会话标题里带上角色（用户**看得到**的告知）。
       *
       * 为什么不用 toast：这条路径末尾会收掉面板，toast 随面板一起不可见；
       * 而"换了角色 → 已新建会话、旧会话绑定不变"这件事必须让用户看得见（需求 §6.3）。
       *
       * 标题里写的是**逻辑 ID**（`rf/rf-天线测量专家`）而不是显示名：这里拿不到角色库
       * （列表只在选择器里读过），而 `personaSelectionLabel` 在没有列表时会给出
       * "（已不在角色库里）"这种**会误导人的**文案 —— 宁可用 id，也不要一句假话。
       */
      const baseTitle = mode === 'idea_association' ? '点子关联' : mode === 'idea_brainstorm' ? '点子头脑风暴' : mode === 'knowledge_doc' ? `知识总结：${docContext?.name ?? '本地文档'}` : mode === 'report' ? `${text.startsWith('week:') ? '周报' : '日报'}：${text.split(':')[1] ?? ''}` : mode === 'plan' ? `AI 计划：${planAnchor.slice(5)}` : mode === 'clarify' ? `澄清：${clarifyText === '' ? '附件任务' : clarifyText.slice(0, 24)}` : mode === 'consult' ? `协助：${task?.title.slice(0, 24)}` : mode === 'breakdown' ? `拆解：${task?.title.slice(0, 24)}` : mode === 'review' ? `复盘：${task?.title.slice(0, 24)}` : `执行：${task?.title.slice(0, 24)}`
      const sessionTitle = personaId === '' ? baseTitle : `${baseTitle} · 角色 ${personaId}`
      await sessionRef.session.rename(sessionTitle).catch(() => undefined)
      let reportContextText = ''
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        const contextRes = await api<{ context: Record<string, unknown> }>(`/api/workbench/reports/context?period_code=${encodeURIComponent(periodCode)}&period_start=${encodeURIComponent(periodStart)}`)
        reportContextText = JSON.stringify(contextRes.context, null, 2)
      }
      /**
       * 当日候选：**唯一实现**在 `shared/dailyPlanPolicy.ts#planCandidates()`（经
       * `client/capacity.ts#todayPlanCandidates` 接线，见 `hooks/useDayWorkspace.ts` 里的候选 memo，
       * 本文件只通过日期域交出的 `planPromptFor` 取同一份结果）。
       *
       * 旧实现内联了一份 filter + `.slice(0, 30)`：它只看"有效截止 < 当日 24:00"，
       * 于是**截止在几天后的长任务压根进不了候选**，AI 看不到就排不出来（用户实测的
       * "排不出来"根因），而且超出 30 条时静默截断、提示词里也不说还有多少条。
       * 现在两条都在纯函数里收口：未来截止的 doing/blocked 进候选、31 条时提示词与
       * 发起窗口都写"另有 N 条未列出"。
       */
      const planPromptPayload = planPromptFor(planAnchor)
      // 任务/子树共享记忆：父任务会话会加载整棵子树上下文，子任务会话也能看到同树记忆。
      let memoryContext = ''
      if (task !== null && (mode === 'execute' || mode === 'consult' || mode === 'breakdown' || mode === 'review')) {
        try {
          const memRes = await api<{ context: string }>(`/api/workbench/tasks/${task.id}/memory-context`)
          memoryContext = memRes.context
        } catch { memoryContext = '' }
      }
      let ideaPrompt = ''
      if (mode === 'idea_association') {
        const selected = ideasAll.filter((idea) => text.split(',').includes(idea.id))
        const lines = selected.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        ideaPrompt = `你是“个人工作台”的点子关联助手。请分析下面的点子，把它们按主题关联成若干个“点子王”（每组 2 个点子以上，点子尽量不重复跨组；若只能成一组也可以）。\n\n候选点子：\n${lines}\n\n请调用 workbench_propose_idea_clusters：\n- clusters: [{title, summary, idea_ids, notes?}]\n- title 简洁有主题感（例如“AI 语音方向”）；summary 1-2 句说明关联逻辑\n- 只提交提案草稿，不要创建或修改点子本身。`
      }
      if (mode === 'idea_brainstorm') {
        let sourceIdeas: Idea[] = []
        let sourceClusterId: string | null = null
        if (text.startsWith('cluster:')) {
          sourceClusterId = text.slice(8)
          const clusterRes = await api<{ cluster: IdeaClusterView | null }>(`/api/workbench/idea-clusters/${sourceClusterId}`)
          sourceIdeas = clusterRes.cluster?.ideas ?? []
        } else {
          sourceIdeas = ideasAll.filter((idea) => text.slice(5).split(',').includes(idea.id))
        }
        const lines = sourceIdeas.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        const typeOptions = dicts.filter((d) => d.kind === 'type').map((d) => `${d.code}=${d.name}`).join(', ')
        ideaPrompt = `你是“个人工作台”的点子落地顾问。请和用户一起把下面${sourceClusterId !== null ? '点子王' : '点子'}头脑风暴成可落地的行动方案。\n\n${sourceClusterId !== null ? `点子王 id：${sourceClusterId}\n` : ''}相关点子：\n${lines}\n\n流程：\n1. 先和用户讨论目标、可行性、第一步（一次问 1-2 个关键问题）\n2. 有结论后调用 workbench_submit_idea_tasks：\n   - source_idea_ids${sourceClusterId !== null ? ' 留空' : '= 讨论的点子 id 数组'}\n   - source_cluster_id${sourceClusterId !== null ? `="${sourceClusterId}"` : ' 留空'}\n   - tasks: 任务数组 {title, description, type_code, priority_code, due_at?, estimated_minutes?, children?}；type_code 必须使用以下字典值：${typeOptions}；priority_code 使用 p0/p1/p2/p3\n   - summary: 1-3 句头脑风暴小结\n3. 只提交提案草稿，不要直接创建任务。`
      }
      let docPrompt = ''
      if (mode === 'knowledge_doc') {
        if (docContext === undefined) throw new Error('知识总结需要文档内容')
        docPrompt = `你是“个人工作台”的知识库总结助手。请阅读下面的本地文档内容，提炼出值得沉淀的知识条目，并调用 workbench_submit_knowledge 提交 pending 草稿。\n\n本地文件：${docContext.fileLink}\n文件名：${docContext.name ?? ''}\n文档内容（${docContext.truncated === true ? '已截断' : '全文'}）：\n"""\n${docContext.content}\n"""\n\n要求：\n- 总结为可检索、可复用的知识条目：背景/结论/可复用做法；正文使用 Markdown\n- title 简洁；kind_code 根据内容选择 note/lesson/decision/snippet；tags 给出 3-5 个关键词\n- file_link 必须填 "${docContext.fileLink}"（或同值的 file:// URL），用于追溯本地文件\n- 只提交知识草稿，不要直接创建知识条目。`
      }
      const planPrompt = `你是“个人工作台”的 AI 计划助手。请为 ${planAnchor}（${'日一二三四五六'[new Date(`${planAnchor}T00:00:00`).getDay()]}）安排执行顺序。\n\n今天：${localDateString()}；当前时间：${new Date().toISOString()}\n\n${planPromptPayload.text}\n\n请综合考虑：优先级（p0 紧急 > p1 高 > p2 普通 > p3 低）、是否已逾期、截止时间、状态（doing/blocked 优先推进）、预计耗时、父子关系与可能的依赖。如果信息不足，可以先问用户 1-2 个关键问题（例如：当天可投入多少小时、哪些必须当天完成）。\n\n然后调用 workbench_propose_daily_plan：\n- plan_date="${planAnchor}"\n- summary：1-3 句排序思路\n- items：扁平顺序数组（1 号最重要），每项 {task_id, order, note, minutes}；note 写清为什么排这里或建议时间块；minutes 是“今天在这条上计划投入多少分钟”（1–1440，不是任务总耗时）\n- 同一父子链上不要同时出现父任务和它下面的子任务；如需排子任务，只排可执行的叶子，并在 note 中说明属于哪个父任务\n- 不要传 effortDone（今日投入是否结束只能由用户操作）\n- 只提交计划草稿，不要修改任何任务字段，不要执行任务。`
      const prompt = mode === 'idea_association' || mode === 'idea_brainstorm'
        ? ideaPrompt
        : mode === 'knowledge_doc'
        ? docPrompt
        : mode === 'report'
        ? `你是“个人工作台”的日报/周报助手。请根据下面 JSON 数据生成一份 Markdown 报告，然后调用 workbench_submit_report。\n\n报告周期：${text.split(':')[0]}（period_start=${text.split(':')[1] ?? ''}）\n数据：\n${reportContextText}\n\n要求：\n- 结构：今日/本周概览 → 已完成 → 进行中/风险 → 明日/下周建议\n- 只依据给定数据，不要编造；数据不足时如实说明\n- title 简洁；summary_md 用 Markdown；stats 可附 {completed, created} 等数字\n- 只提交草稿，不要修改任务，不要执行任务。`
        : mode === 'plan'
        ? planPrompt
        : mode === 'clarify'
        ? buildQuickIntakePrompt({
          taskText: clarifyText,
          attachments,
          documentTexts: attachments.filter((item): item is QuickDocumentDraft => !isQuickImageDraft(item)).map((doc) => ({ name: doc.name, content: doc.content, truncated: doc.truncated })),
          nowIso: new Date().toISOString(),
          workspaceRootLabel: ws.items.find((item) => item.workspaceId === workspaceId)?.path ?? '当前连接工作区',
          reservedTaskId,
          taskFolderPath,
          taskFolderRelative: taskFolderRelative === '' ? '' : `./${taskFolderRelative}/`,
          /**
           * 本次会话模型那一行必须与**真的生效的那个**一致：
           * 降级时不能把上次选的模型名写进提示词（那会让 AI 与用户都以为换了模型）。
           */
          modelLabel: effectiveModelLabel(selectionApplication, mode === 'clarify' ? quickModelSelection : promptModelSelection),
        })
        : mode === 'consult'
          ? `你是“个人工作台”的任务协助助手。请针对下面这个任务提供咨询、拆解或复盘建议（咨询模式不执行）。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 状态：${task?.statusCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请先理解任务，再给出建议；如果信息不足，可以一次问一个问题。\n\n重要：如果用户要求把结论/补充信息保存回任务，请调用 workbench_update_task(task_id="${task?.id ?? ''}", description="...") 更新原任务；绝对不要调用 workbench_submit_task 新建任务。`
          : mode === 'breakdown'
            ? `你是“个人工作台”的任务拆解助手。请分析下面这个任务，并调用 workbench_propose_subtasks 提交子任务提案。\n\n父任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n粒度规则：每层 2-6 个、最大深度 3 层、叶子 15-240 分钟且有可验证完成标准；子任务的 type_code/priority_code 默认继承父任务；若任务太小，设置 no_breakdown_needed=true。只提交提案，不要执行。如果用户对提案提出修改意见，请带上上一次工具返回的 draft_id 再次调用 workbench_propose_subtasks 更新同一份提案。`
            : mode === 'review'
              ? `你是“个人工作台”的任务复盘助手。请对下面这个已完成任务做复盘：\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请从“做得好 / 做得不好 / 下次改进”三个角度输出 Markdown，并调用 workbench_submit_review(task_id="${task?.id ?? ''}", summary_md="...", lessons=[{"title":"...","content":"..."}])。`
              : `你是“个人工作台”的任务执行助手。请直接完成下面这个任务，不要反复确认已知信息。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树，父任务会话会看到整棵子树上下文）：\n${memoryContext}` : ''}\n${previousSessions.length > 0 ? `\n该任务此前已有执行会话：${previousSessions.map((s) => String(s.session_id ?? '')).filter((x) => x !== '').join('、')}\n若这些会话有未完成上下文，请先向用户索取上一会话的总结/未完成事项再继续，不要重复已完成工作。` : ''}\n\n执行过程中请遵守：\n- **阶段性推进后主动报一次进度**：调用 workbench_update_progress(task_id="${task?.id ?? ''}", progress=<0-99 的整数>, note="这一步做了什么")。进度是显式值，直接生效、不需要用户确认；不要替用户推算，也不要从子任务比例派生。\n- 如果有关键上下文、阶段性结论、决策或未完成事项，请调用 workbench_save_task_memory(task_id="${task?.id ?? ''}", content="...", kind="note|decision|summary") 写入任务共享记忆，便于后续会话续作。\n- 若当前任务是父任务，且你直接完成父任务，验收通过后系统会级联完成所有未完成子任务。\n- 全部做完时调用 workbench_update_progress(task_id="${task?.id ?? ''}", progress=100, summary="2-4句完成总结")（等价于 workbench_request_completion）提交完成验收；**100 不是进度值**，它表示提交验收，库里不会写入 100。等用户在个人工作台验收；在用户验收通过前，任务不算完成，不要声称已经完成。若任务无法完成，如实说明原因，不要提交验收。`
      if (mode === 'execute') {
        if (task === null) throw new Error('执行模式需要选择一个任务')
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') throw new Error('该任务已完成或已取消，不能再次执行')
        if (task.aiPolicyCode !== 'execute') throw new Error('该任务未开启“可执行”，请先在任务详情中把 AI 策略改为“可执行”')
      }
      // 澄清模式：AI 会话已经接住这条输入，快速录入弹窗就该收起来（P6-3 会把这一行改成注入的
      // `closeQuickEntry()` —— 语义与快速录入域的 `closeIntake` 完全一致：只关窗、不清附件）。
      if (mode === 'clarify') closeIntake()
      const basePrompt = customPrompt.trim() === '' ? prompt : `${prompt}\n\n用户补充要求：\n${customPrompt.trim()}`
      /**
       * ============================================================
       * 角色绑定（AX-R04：**必须在首次 prompt 之前**）
       * ============================================================
       *
       * - 未指定 / 无角色 → `personaIdToBind()` 返回 `''` → **不写绑定、不改提示词**，
       *   于是"默认无角色时的最终提示词逐字等于原流程"（AX-R07）；
       * - 明确选了角色 → 先把 `{sessionId, personaId}` 打到 `/personas/bind`（服务端解析校验、
       *   幂等/409 都由 `personas/binding.ts` 一处判定），**绑定失败就抛错、不发送 prompt** ——
       *   否则用户会以为"选了角色"，实际这一轮根本没有角色可用。
       */
      if (personaId !== '') {
        const bound = await api<{ ok: boolean; binding: { personaId: string; revision: string } }>('/api/workbench/personas/bind', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: id, personaId }),
        })
        if (bound?.binding?.personaId !== personaId) {
          throw new Error(`角色「${personaId}」绑定未生效（服务端返回的不是这个角色），本次没有发送 prompt。请重新选择角色。`)
        }
      }
      /**
       * 提示词拼装顺序（需求 §6.4）：**角色块 → 技能块 → 正文**。
       *
       * ⚠️ 两个函数都是"往前面拼"，所以嵌套顺序与最终顺序**相反**：
       * 先拼技能块（它贴到正文前），再拼角色块（它贴到最前面）。
       * 两个块都只是"加载指令"，都不内联正文；都为空时提示词逐字不变。
       */
      const finalPrompt = withPersonaPromptBlock(withSkillPromptBlock(basePrompt, skillNames), personaId)
      /**
       * 图片**前置**在文本之前（与宿主 `PromptContentPart` 的惯例一致），
       * 走的是宿主原生多模态管线；未声明 image 的模型已在上面拦下并给出可读原因。
       */
      const result = await sessionRef.session.prompt([...imageParts, { type: 'text', text: finalPrompt }], 'queue')
      if (result.ok === false) throw new Error(result.error !== undefined ? String(result.error) : '发送失败')
      if (mode === 'clarify') clearQuickAttachments()
      if (mode === 'plan') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: 'daily_plan', anchor: planAnchor, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: periodCode === 'week' ? 'week_report' : 'day_report', anchor: periodStart, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'idea_association' || mode === 'idea_brainstorm') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: mode, anchor: text, sessionId: id, workspace: workspaceId }) })
      }
      if (task !== null && mode !== 'clarify') {
        await api(`/api/workbench/tasks/${task.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, roleCode: mode }) }).catch(() => undefined)
      }
      // 这里已经 await 过多次：期间插件可能被卸载/重载，先确认还活着再动宿主服务。
      if (!isAlive()) return
      // 先开会话再关面板：关面板会卸载本面板的 React 树，顺序反了就成了"点了没反应"。
      openSessionInPanel(id)
    } catch (e) {
      if (isAlive()) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (isAlive()) setBusy(false)
      /** 与 `acquireSession` 里的 retain **成对释放**；复用路径没 acquire 过，故用 `?.`。 */
      sessionRef?.release()
    }
  }

  /**
   * 复用型会话：计划/报告/点子关联/点子头脑风暴 —— 每个 scope+anchor 只有一个会话。
   *
   * 命中返回 `{kind:'reuse', sessionId}`，**没命中返回 `{kind:'new'}`**（"该走新建流程"，
   * 而不是抛错）；`notice` 只在"因为换了角色而不复用"时非空（要显式告知用户）。
   *
   * ## 三条判据都在这里（原先是内联在 `startAISession` 里的一大段）
   *
   * 1. **登记行**（`ai_session_registry` 表）：登记行 ≠ "会话还在" —— 用户把那个对话归档以后，
   *    宿主只把 id 收进归档集、连文件都不删，`sessions.open()` 照样"成功"，
   *    随后宿主清掉选中，用户看到的是"点了没反应"。所以登记行必须过
   *    `aiSessionUsable`；判据不成立时**落回新建流程**（登记接口是 upsert，会覆盖陈旧那行）。
   *    计划还额外要求"确有当日计划或待确认草稿"，否则同样当没命中。
   * 2. **报告行自己的 sessionId**：报告落库后再点同一天，登记那条路已被判据拦住，
   *    这里若不判就会裸切一个已归档 / 已删除的会话（用户实测：点了没反应）。
   * 3. **角色选择**（AX-R08，v1.15.9 新增）：会话还能用**不等于**可以沿用 ——
   *    如果用户这次明确选了一个与既有绑定不同的角色，必须新建会话（旧会话绑定不变）。
   *    判据是纯函数 `decidePersonaReuse()`（三态 × 有无绑定，表驱动单测）；
   *    这里只负责"取既有绑定 → 问判据 → 照做"。**旧实现在这里无条件早退**，
   *    把用户的选择整个吞掉 —— 那正是 AX-R08 点名要防的。
   *
   * 抽出来只有一个目的：让 `startAISession` 里的复用分支瘦成"命中就早退"，
   * 于是新建路径（要 acquire 会话引用那条）**不必被包进任何 if 块**，
   * 也就不会产生整段重排的噪声 diff。参数显式传入，不靠闭包猜作用域。
   */
  const reuseAiSessionId = async (
    mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc',
    text: string,
    planAnchor: string,
    persona: PersonaSelection,
  ): Promise<{ kind: 'reuse'; sessionId: string } | { kind: 'new'; notice: string }> => {
    const fresh = { kind: 'new' as const, notice: '' }
    if (mode !== 'plan' && mode !== 'report' && mode !== 'idea_association' && mode !== 'idea_brainstorm') return fresh
    const [scopeCode, anchor] = mode === 'plan'
      ? ['daily_plan', planAnchor]
      : mode === 'idea_association' ? ['idea_association', text]
        : mode === 'idea_brainstorm' ? ['idea_brainstorm', text]
          : text.startsWith('week:') ? ['week_report', text.slice(5)] : ['day_report', text.slice(4)]
    let candidate = ''
    const existing = await api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${scopeCode}&anchor=${anchor}`)
    if (existing.session !== null && aiSessionUsable(runtime, existing.session.sessionId)) {
      let shouldReuse = true
      if (mode === 'plan') {
        const hasPlan = planAnchor === localDateString()
          ? todayPlan !== null
          : pickedPlan !== null && pickedPlan.planDate === planAnchor
        const hasPendingPlanDraft = pendingDraft !== null && pendingDraft.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === planAnchor
        shouldReuse = hasPlan || hasPendingPlanDraft
      }
      if (shouldReuse) candidate = existing.session.sessionId
    }
    if (candidate === '' && mode === 'report') {
      // 旧版本生成的报告可能还没有登记会话：直接复用报告里的 session_id。
      const periodCode = text.startsWith('week:') ? 'week' : 'day'
      const rep = await api<{ report: { sessionId?: string | null } | null }>(`/api/workbench/reports/${periodCode}/${anchor}`)
      if (typeof rep.report?.sessionId === 'string' && rep.report.sessionId !== '' && aiSessionUsable(runtime, rep.report.sessionId)) candidate = rep.report.sessionId
    }
    if (candidate === '') return fresh
    /**
     * 已有的角色绑定（没绑过 / 绑定记录坏了都按 `null` 处理：坏绑定在加载工具那条路会被
     * 明确拒绝，这里**不**为了"判复用"去猜它绑的是什么）。
     */
    let binding: PersonaBindingView | null = null
    try {
      const res = await api<{ binding: PersonaBindingView | null }>(`/api/workbench/personas/bind?session_id=${encodeURIComponent(candidate)}`)
      binding = res.binding ?? null
    } catch { binding = null }
    const decision = decidePersonaReuse(persona, binding)
    if (decision.action === 'reuse') return { kind: 'reuse', sessionId: candidate }
    return { kind: 'new', notice: decision.notice }
  }

  /**
   * 澄清入口每次打开时的复位（P6-3 新增，因 `openQuickEntry` 拆成两半而显式化）。
   *
   * 与共享提示词弹窗的 `askUserPrompt` 做的是同一件事（角色 → 未指定、技能清空、重拉目录），
   * 区别只在于那边弹窗自己打开。原文注释搬到这里：
   *
   * - 每次打开都把角色复位成「未指定」：上一次误点过的角色不该**静默**成为这一次的选择
   *   （默认值必须是"无角色 / 不改变原有行为"，这是 AX-R07 的前提）。
   * - 技能同理（2026-10-01）：每次打开都复位选择并**拉一次技能目录**。为什么必须在这里拉：
   *   `loadSkills()` 原来只在 `askUserPrompt`（共享提示词弹窗）里调，而快速录入从不走那个入口
   *   —— 于是快速录入里的技能块永远是"暂不可用"或空的（用户反馈的"快速录入无法选择 SKill"
   *   有一半是这个）。与角色一样，上一次的选择不该静默成为这一次的（默认=不注入技能）。
   */
  const resetClarifyPicker = (): void => {
    setQuickPersona(INHERIT_PERSONA)
    setSelectedSkills([])
    setSkillQuery('')
    void loadSkills()
  }

  return {
    quickModelSelection, modelModalityTable, promptModal,
    skillCatalog, skillsAvailable, skillsLoading, skillProblem,
    skillQuery, selectedSkills, promptPersona, quickPersona, promptModelSelection,
    actions: {
      setQuickModelSelection, setPromptModelSelection, setModelModalityTable,
      setPromptModal, setPromptPersona, setQuickPersona,
      loadSkills, confirmPrompt, cancelPrompt, toggleSkill, openSessionInPanel,
      startAISession, resetClarifyPicker,
    },
  }
}
