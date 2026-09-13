/**
 * 客户端共享常量：面板挂载点与宿主注入钩子的 data-attribute 名。
 * 单独成文件是因为样式（styles.ts）与组件（index.tsx）都要引用同一批名字。
 */

export const PANEL_NAME = 'personal-workbench'
export const ACTIVE_ATTR = 'data-dsh-personal-workbench-active'
export const PENDING_ATTR = 'data-dsh-personal-workbench-pending'
export const VIEW_ATTR = 'data-dsh-personal-workbench-view'

/**
 * v1.14.53：家族事件常量 `ACTIVATE_EVENT = 'dsh-panel-activate'` 已删除。
 *
 * 它是社区插件之间"我开了、你让位"的土办法（`document.dispatchEvent(new CustomEvent(...))`）。
 * 进入官方槽位机制后，面板互斥由宿主的 `activePanelId` 保证，
 * 我们**不再广播也不再监听它** —— 设计与归因见 README 的"面板互斥与兄弟插件冲突"一节。
 * 留着这个常量只会让人以为我们还在参与那套协议（`test/clientInvariants.test.mjs` 会拦）。
 */

/**
 * 「官方槽位路径已就绪」标记（挂在 documentElement 上，v1.14.0）。
 *
 * 为什么需要它：面板内容有两个可能的宿主容器 ——
 * ① 官方 `main` 槽位（宿主渲染，迁移后的正路）；
 * ② 本插件自己塞进会话列的覆盖层（DOM 降级腿，同时是官方路径失效时的兜底）。
 *
 * 两者会**同时存在**，但同一时刻只能有一个真正承载 React 树：
 * `WorkbenchApp` 内部有轮询、toast、Modal，挂两份会互相打架
 * （2026-09-12 实测：弹框重复、点一次「暂存」要点 5-8 次、背景闪烁）。
 *
 * 所以用这个属性把"谁是当前容器"显式标出来，由 CSS 保证只有一个可见：
 * - 属性存在 = 官方路径就绪 → 只显示 `main` 里的容器；
 * - 属性不存在 = 走降级腿 → 只显示覆盖层容器。
 *
 * 这样即使官方注册中途失败，界面也**不会变成空白**（兜底那一路立刻接上）。
 */
export const OFFICIAL_ATTR = 'data-dsh-personal-workbench-official'

/** 标记「这个容器是当前激活的 App 宿主」；由 React 树所在的那一路设置，见 OFFICIAL_ATTR。 */
export const HOST_ACTIVE_ATTR = 'data-dsh-personal-workbench-host-active'

/**
 * 标记「这一行是宿主渲染的官方面板行，已被我们隐藏」（v1.14.36）。
 *
 * 为什么需要：走自建腿时（例如本机 layout 服务不可达 —— 官方行点了切不动面板），
 * 自建入口行才是唯一可用的入口，而宿主仍会渲染它自己那一行 → 侧栏出现**两个**
 * 「工作台」入口（用户实测反馈）。这条属性用于隐藏官方行并保持幂等
 * （避免重复扫描时反复作用，也便于排查时一眼看出"这行是被我们藏掉的"）。
 */
export const REDUNDANT_ROW_ATTR = 'data-dsh-personal-workbench-row-hidden'

/**
 * 侧栏入口那套家族契约（`ENTRY_ATTR` / 语义属性 / 行结构 / 折叠态识别）见
 * `entryContract.ts`：那里是纯常量与纯函数，可以被 node --test 直接锁住不变量。
 */
