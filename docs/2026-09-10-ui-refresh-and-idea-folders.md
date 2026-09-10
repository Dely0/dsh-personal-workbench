# 工作台 UI 视觉层重构 + 点子文件夹 + 用户入口槽位（v1.13.x）

- 日期：2026-09-10
- 版本：1.13.0（功能）/ 1.13.1（修复崩溃）
- 相关任务：工作台 UI 美化（主界面 + 报告/知识库/点子页）

## 0. 结论先行

本次做了三件事，**信息架构一行未改**：

1. **视觉层**：统一边框/阴影/字号/间距，保留用户要求的「中档对比度」（模块必须能看出边界）。
2. **今日容量条**：新增一个数据驱动的元素，把"今天投得进多少时间"显式化。
3. **用户入口**：从"插件用 MutationObserver 往侧栏插 DOM"改为 DSH **官方槽位**注册会话标题栏按钮。
4. **点子页**：从"平铺卡片 + AI 提案列表"改为**文件夹优先**（数据层早就支持，只是没显性化）。

## 1. 视觉层：为什么不是"去边框"

初版设计稿（v1）把卡片边框与阴影去掉，被用户否掉，理由是**DSH 浅色模式下白卡叠白底会看不清模块边界**。核对后确认这是对的：

| 档位 | 边框 | 阴影 | 结论 |
|---|---|---|---|
| 轻（初版，已废弃） | `rgba(2,6,23,.075)` | `0 2px 8px rgba(0,0,0,.04)` | 太淡，模块糊在一起 |
| **中（采用）** | `var(--dsw-alias-border-l1, rgba(127,127,127,.26))` | `0 1px 2px / 0 2px 8px rgba(0,0,0,.05~.06)` | 浅色下可辨识，深色下不刺眼 |
| 强 | `rgba(127,127,127,.32)` | `0 6px 18px rgba(0,0,0,.10)` | 块状感过重 |

实现方式：`styles.ts` 末尾新增一个 `[data-dsh-personal-workbench-view]` 作用域块，声明一层自有令牌
（`--wb-line` / `--wb-surface` / `--wb-accent` / `--wb-sh-1` …）并覆盖相关组件。**令牌一律映射回宿主
`--dsw-alias-*`**，因此浅色/深色自动跟随外壳，不引入自有配色。语义色（p0–p3、完成）只用于小面积
（圆点、药丸、容量条分段），不做整块底色。

唯一强调色从原先到处混用的蓝色改为**深墨绿** `color-mix(#2E9B7B 62%, #14493A)`，用于选中态与主操作。

## 2. 今日容量条（新元素）

- 口径：当天要做的事 = 今天到期 + 无截止时间的 doing/blocked；没有 `estimatedMinutes` 的按 30 分钟兜底
  （否则"没填估算 = 零成本"会让容量条失真）。
- 展示：按优先级分段的时间轴 + 图例（每档分钟数）+ 「已排 / 可投入 / 余」三个数字。
- 可投入时长：点击数字行内编辑，存 `meta.daily_capacity_minutes`（默认 390，夹 30–1440），
  接口 `/api/workbench/settings` 的 GET/POST 都带 `dailyCapacityMinutes`。

## 3. 用户入口：cordis 服务读取的铁律

**背景**：原入口是插件用 `MutationObserver` 往 DSH 侧栏插 DOM（依赖宿主 class 名，升级易断）。
改为官方槽位：

```ts
ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
  { name: 'conversation.session.header.actions', id: 'personal-workbench', order: -4, inject: () => ({ workbench: api }) },
  WorkbenchHeaderEntry,
))
```

`conversation.session.header.actions` 的作用域是 **session**，所以注册一次、**每个会话标题栏都会出现**
「工作台」按钮，点击即切换开关（再点收起）。DSH 侧栏入口保留。

**槽位能力边界（实测）**：`conversation.view`（会话内视图页签）只有 DSH 自带包（chat / trajectory）在用，
第三方插件注册不了；可用的只有 `header.actions / header.utilities / header.corner / input.dock /
composer.dock / sidebar.footer.action / shell.overlay` 这些"按钮位"。

### 事故与修复（1.13.0 → 1.13.1）

初版这样读服务：

```ts
const candidate = runtime.slots ?? runtime.get?.('slots')   // ❌ 整个 client apply 崩溃
```

cordis 的 ctx 是 Proxy：**访问未在 `inject` 声明的服务时属性访问直接抛错**，不返回 undefined，
所以 `??` 兜底永远执行不到。正确写法是走**非严格软读** `ctx.get('slots')`：

```ts
const withGet = runtime as unknown as { get?: (name: string) => unknown }
const candidate = withGet.get?.('slots')
```

**铁律**：要软探测/可选依赖，一律 `ctx.get('x')`；绝不用 `ctx.x`。
（1.11.0 的 skills 探测用的就是 `ctx.get('skills')`，所以一直没出问题。）

## 4. 点子页：文件夹优先

用户最初的产品意图是"把多个点子自动关联并合并到一个文件夹"。核对后确认**数据层早已支持**：

| 需求 | 现有支撑 |
|---|---|
| 点子归类到文件夹 | `idea_clusters`（文件夹）+ `idea_links`（成员，主键 `(cluster_id, idea_id)` → 天然多对多） |
| AI 自动关联 | `workbench_propose_idea_clusters` 提案 → 确认后建组 |
| 一个点子进多个文件夹 | 已支持（无需迁移） |
| 手动建空文件夹 / 改名 / 删除 / 合并 / 成员移入移出 | **本次补齐** |

新增接口（全部 loopback 围栏）：

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/idea-clusters` | 新建（可空文件夹） |
| PATCH | `/idea-clusters/:id` | 改名 / 改摘要 / 改标签 |
| DELETE | `/idea-clusters/:id` | 删除文件夹（点子保留，回到未归类） |
| POST | `/idea-clusters/:id/ideas` | 把点子归入（幂等，可多个文件夹） |
| DELETE | `/idea-clusters/:id/ideas/:ideaId` | 把点子移出 |
| POST | `/idea-clusters/:id/merge` | 把本文件夹并入目标（成员挂过去 + 删除自身，目标原有成员保留） |

前端：文件夹卡（成员缩略 + 数量 + hover 改名/删除）+ 「未归类」散点子区（卡片上「归入文件夹 ▾」）
+ 右栏文件夹详情（成员列表带移出、合并到…、AI 继续补充关联、整体转任务树）+ 新建/改名弹窗。
术语上 UI 统一叫「文件夹」，数据库仍叫 `idea_clusters`。

## 5. 验证

| 项 | 结果 |
|---|---|
| `pnpm check` | 通过 |
| `pnpm test` | 85/85（新增点子文件夹全链路测试 1 项） |
| 真机 15/15 | health=1.13.0、`dailyCapacityMinutes` 读写与越界夹取、文件夹建/改名/归入/多对多/移出/合并/删除、无残留 |
| 会话标题栏按钮 | 用户实测：应用正常加载、按钮渲染且可点击、控制台零警告 |
| 发布 | npm `@dely0/dsh-personal-workbench@1.13.1`（latest） |

## 6. 后续

- 文件夹嵌套（`parent_cluster_id`）与拖拽排序未做。
- 「整体转成任务树」目前复用头脑风暴会话（带 `cluster:<id>`），未做一键提案。
- 视觉层仍有可收敛处：设置弹窗、Toast、会话选择器等尚未逐一走查。
