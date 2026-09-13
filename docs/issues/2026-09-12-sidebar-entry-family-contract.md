# FIX：侧栏「工作台」入口纳入 sidebar-entry 家族契约

| 项 | 内容 |
|---|---|
| **修复日期** | 2026-09-12 |
| **对应 issue** | [Dely0/dsh-personal-workbench#3](https://github.com/Dely0/dsh-personal-workbench/issues/3) |
| **代码基线** | `d39cc3d`（v1.13.3）→ 本工作区 `main` |
| **严重级别** | P1（功能可见缺陷：与兄弟侧栏插件同开时两个入口同时高亮、两个面板同时挂在会话列上） |
| **验证环境** | DSH 0.1.5-rc.1（Web）/ Windows 11 / Node v24.19.0；`pnpm typecheck` + `pnpm test`（102 项） |
| **是否已验证** | 代码级 + 测试级已验证；**实机带兄弟插件的双向互斥待用户验证**（本机未装 dsh-mnemon / task-board / ssh） |

---

## 1. 这个「家族」是什么

上游 DSH **没有**侧栏导航的官方 slot（当时的替代是 DOM 注入），所以 `dsh-ssh` /
`dsh-client-ui-task-board` / `dsh-client-ui-skill-explorer` / `dsh-mnemon` 之间形成了
一套约定俗成的 DOM 契约：

| 约定 | 形式 |
|---|---|
| 行标识 | 行元素带 `data-dsh-<pkg>-entry` |
| 语义属性 | `data-dsh-plugin="<id>"` + `data-dsh-part="sidebar-entry"`（皮肤中心锚定用） |
| 无障碍 | `aria-label` + `title`（折叠态无文案时仍可读） |
| 行样式基线 | `min-height:36px / gap:10px / padding:0 10px` |
| 折叠态 | 36px 圆形 + `margin:0 auto 12px` |
| 激活态 | 行上 `data-active` |
| 面板互斥 | 广播 `dsh-panel-activate`（detail = 插件名）+ 自己挂 `html[data-dsh-<pkg>-active]` |

本插件是第 5 个到达的侧栏插件，但**从未加入这套约定**：只有自己的
`data-dsh-personal-workbench-entry`，行内是 `svg + span.wb-label`，尺寸自成一套。
issue #3 的三个现象都是这个缺席的直接后果。

---

## 2. 逐条根因与核实（修复前，v1.13.3）

issue 里引用的行号与代码**逐条吻合**，核实结果：

| issue 断言 | 修复前实际代码 | 结论 |
|---|---|---|
| `index.tsx:2513` 家族选择器只列 taskboard/ssh | 一致（漏 `mnemon`，也不含自身） | 属实 |
| `:2487` 无 `data-dsh-plugin` / `data-dsh-part` | 一致（全仓库 grep 零命中） | 属实 |
| `:2488` 行内无 `aria-label` / `title` | 一致 | 属实 |
| `styles.ts:17-23` 自有尺寸 `32px / 12px` | 一致 | 属实 |
| `constants.ts:11` `SIBLING_ATTRS` 缺 mnemon | 一致 | 属实 |
| `:2529` 点击清单缺 `[data-dsh-*-entry]` | 一致 | 属实 |

**额外发现（issue 与贡献者分支都没提到的两处真实缺陷）：**

1. **折叠态样式是死代码。** 旧写法 `[data-dsh-frame][data-sidebar-collapsed] …` 要求祖先带
   `data-dsh-frame`，而 DSH 宿主（`dsh-client-ui-layout` 的 AppFrame）**根本没有这个属性** ——
   折叠标记只写在 frame 元素上（`data-sidebar-collapsed`），外加 CSS Module 哈希类
   `hHd-Xa_collapsed`。也就是说该规则在 0.1.5 上永不命中。
2. **面板门控写死了兄弟插件名。** 旧 CSS 是
   `html[ACTIVE]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active])`。
   当 `dsh-mnemon` 后开面板时，这个门控不认 mnemon 的标记 → 本插件 overlay 继续显示，
   于是「两个面板同时挂在会话列上」正是这条写死清单造成的，而不只是事件协议问题。
3. **折叠态必须实时跟，不能只在插入时算一次。** DSH 的折叠/展开只改 frame 上的
   `data-sidebar-collapsed` 与侧栏根的类名，**不重建 DOM**；而 `placeEntry()` 在
   `placed` 为真时直接 return。因此实现里额外监听 `data-sidebar-collapsed` 的属性变化
   （`documentElement` + `document.body` 子树两处），否则收起侧栏后入口不会变成圆形。

**关于贡献者分支的一处纠正：** 该分支称
`--dsw-specific-sidebar-nav-item-hover/active` 由皮肤中心注入、未装皮肤中心时未定义。
经核对**不成立**：DSH 自带主题包 `@deepseek-ai/dsh-client-ui-theme` 在
`body{}`（浅色）与 `body[data-ds-dark-theme]{}`（深色）两处都定义了这两个令牌。
真实问题是**用错了令牌族**——宿主自己的面板行与兄弟插件用的是
`--dsw-alias-interactive-bg-hover/active`，用 `--dsw-specific-*` 会导致同排入口高亮色不一致。
（两者都无 `var()` 兜底，故一并补上兜底。）

---

## 3. 改了什么

新增 `src/client/entryContract.ts`：把「家族契约」收成一个纯常量/纯函数的模块
（无 DOM 依赖、无 React），因此可以被 `node --test` 直接锁住不变量。

| 文件 | 改动 |
|---|---|
| `src/client/entryContract.ts`（新） | 契约常量（行标识 / 语义属性 / 三段式结构 / 图标 / aria）+ `entryCss()` + `isSiblingActiveAttribute()` / `isSiblingPanelActive()` / `matchesCollapsedClass()` |
| `src/client/index.tsx` | 入口行输出 `class="dshWorkbench_entry"` + 三段式结构 + `data-dsh-plugin` + `data-dsh-part="sidebar-entry"` + `aria-label`/`title`；新增 `syncCollapsed()`；互斥改为**格式驱动**（摘掉任何 `data-dsh-*-active`）；面板门控落到动态 `data-dsh-personal-workbench-blocked`；锚点改为固定（紧跟 logoRow 之后） |
| `src/client/styles.ts` | 入口行样式改为引用 `entryCss()`；面板门控从「逐个 `:not(兄弟标记)`」改为 `:not([blocked])` |
| `src/client/constants.ts` | 移除 `ENTRY_ATTR` / `SIBLING_ATTRS`（迁到 entryContract，避免两处定义） |
| `tsconfig.build.json` | 把 `entryContract.ts` 纳入产物（测试要 import 构建后的 js） |
| `package.json` | `test` 脚本由硬编码文件清单改为 `test/*.test.mjs`（新测试自动纳入） |
| `test/entryContract.test.mjs`（新） | 11 项契约回归守卫 |

### 关键设计决定

**互斥改为属性名格式驱动，不再靠包名清单。**

```
旧：SIBLING_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
    CSS: html[ACTIVE]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active])
新：判定 data-dsh-<任意>-active（排除自己）→ 结果写到 documentElement 的 blocked 标记
    CSS: html[ACTIVE]:not([data-dsh-personal-workbench-blocked])
```

理由：家族每新增一个成员，所有老插件都要改一遍硬编码清单，漏一个就是本 issue。
按属性名格式识别后，将来新增的兄弟插件**自动覆盖**，并且 CSS 不再需要知道任何兄弟插件名。

**锚点改为固定位置。** 旧实现用 `insertBefore(entry, family[0])`，位置取决于兄弟插件谁先渲染，
顺序不稳；改为固定紧跟 logoRow 之后（与外部贡献者分支的做法一致）。

---

## 4. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | **102 项全通过**（原 91 项 + 新增 11 项契约守卫） |
| 构建产物核对 | `lib/client.js` 含 `data-dsh-plugin` / `sidebar-entry` / `dshWorkbench_entry*` / `data-sidebar-collapsed` / `blocked`；**已无** `data-dsh-frame`、`data-dsh-taskboard-active`、`data-dsh-ssh-active`、旧 `wb-label` |

新增的 11 项守护的正是**曾经真实偏离过**的点：家族选择器漏项、缺语义属性、
缺 aria/title、折叠态写死 `data-dsh-frame`、行样式退回 32px/12px、样式里再次硬编码兄弟包名。

**尚未验证（需实机）：** 本机 web profile 未安装 `dsh-mnemon` / `@linxin666/dsh-ssh` /
`dsh-client-ui-task-board` / 皮肤中心，因此「开着 Mnemon 点工作台 → Mnemon 让位」
这一双向互斥**未在真实多插件环境跑过**。装齐兄弟插件后需验证：

1. 先开 Mnemon 再点「工作台」→ 只剩工作台入口高亮；
2. 先开工作台再点 Mnemon → 工作台面板让位（blocked 门控生效）；
3. 装了皮肤中心时该行能吃到 `sidebar-entry` 语义覆盖；
4. 侧栏折叠态下入口呈 36px 圆形、与同排一致。

---

## 5. 未纳入本次范围

- **DSH 0.1.5-rc.1 已有官方侧栏槽位** `sidebar.panellist`（kind: list, scope: root）+ 中央面板槽位
  `main`（keyed, scope root，键 = 侧栏入口 id）。宿主 `PanelRow` 自带 `aria-label`、
  active 高亮与 `activePanelId` **单值状态**，即「同一时刻只有一个面板激活」由宿主保证，
  家族那套约定在该入口上不再需要。改用官方槽位可根治本 issue，但属入口重写
  （面板内容需迁到 `main` 槽位、`layout` 服务要软探测并保留旧宿主降级路径），
  已单列为 v1.14.0 议题，**不在本次修复范围内**。
  本次的家族契约实现在官方槽位落地后仍是**旧宿主降级腿**，不会废弃。
- 未发布 npm / 未提 PR / 未改动目标仓库远端：按团队约定，先本机验证再发布。
