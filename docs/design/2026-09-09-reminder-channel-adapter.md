# 设计 1/3：`ChannelAdapter` 契约与降级语义

> 上游设计：`2026-09-08-wechat-task-reminder.md`（§5.2 为提案版）
> 本文档是**可照写代码的定稿**，实现见 `src/reminder/adapter.ts`
> 定稿日期：2026-09-09

---

## 1. 定位

ChannelAdapter 是「工作台策略层」与「dsh-im 通道」之间的**薄适配层**：策略层只说"发这条提醒"，适配层负责"用哪条通道、发不出去怎么办"。

**职责边界**（不放进来的一律不做）：

| 归适配层 | 归策略层 | 归 dsh-im |
|---|---|---|
| 软探测通道可用性 | 分级 / 静默 / 每日汇总 | 扫码、凭证、协议 |
| 调用 `send` 并归一化错误 | 节流预算与熔断判定 | iLink 长轮询 |
| 熔断状态机与队列持久化 | 决定"这条要不要发" | 平台原生路由 |
| 降级到浏览器/桌面通知 | 幂等与补发窗口 | context_token 缓存 |

**硬约束**：适配层永不 reject，永不抛错；所有失败都变成 `SendResult`。

---

## 2. 契约

```ts
type SendOutcome =
  | { ok: true; delivered: true }
  | { ok: false; reason: 'not-installed' | 'not-configured' | 'channel-offline' | 'throttled' | 'failed'; detail?: string; retryAfterMs?: number }

interface ReminderChannel {
  readonly id: 'wechat'
  /** 每次发送前软探测：支持"先装工作台、后装 dsh-im" */
  available(): boolean
  /** 永不 reject */
  send(message: { title: string; body: string; priorityCode: string }, opts?: { signal?: AbortSignal }): Promise<SendOutcome>
  /** 供设置页展示 */
  status(): ChannelStatus
}

interface ChannelStatus {
  installed: boolean          // ctx.get('dshIm') 是否可用
  configured: boolean         // 是否已解析出 botId + targetId
  botId: string | null
  targetId: string | null
  botLabel: string | null     // 展示用（机器人名），不含敏感信息
  circuitOpen: boolean        // 是否处于熔断
  circuitUntil: string | null
  queued: number              // 待发队列长度
}
```

### 2.1 为什么 `available()` 每次发送前都探测

`ctx.get('dshIm')` 是廉价查表（cordis `reflect.ts` 语义：未提供返回 `undefined`，不抛错），而**用户可能在运行中安装/卸载 dsh-im**。缓存探测结果会导致"装了还要重启才生效"。

### 2.2 为什么绝不用 `ctx.dshIm` 或 `inject: ['dshIm']`

- `ctx.dshIm` 属性访问在未声明 inject 时**直接抛错**（cordis Proxy 陷阱）；
- `inject: ['dshIm']` 会让宿主在未安装时 **pending、阻塞启动**。
两者都会破坏「微信是可选增量」这条底线。实现里只允许出现 `ctx.get('dshIm')`。

---

## 3. 目标解析（botId / targetId）

**不手工填 ID**。运行时从 dsh-im 自动发现：

```ts
const im = ctx.get('dshIm')
const bots = await im.listBots()                       // [{ botId, name?, channel?, status? }]
const targets = await im.listTargets(botId)            // [{ targetId, name?, kind, route }]
```

解析优先级：

1. 设置里显式保存的 `botId` + `targetId`（用户在下拉里选过）；
2. 设置里只存了 `botId` → 取该 bot 下第一个 `kind === 'user'` 的目标；
3. 都没有 → 若只有 1 个 bot 且它有目标，自动采用（零配置可用）；否则 `not-configured` 并提示去设置页选。

**只取 `channel === 'weixin'` 的 bot**，避免误发到飞书/钉钉。

---

## 4. 降级语义（用户可见口径）

| 场景 | `reason` | 行为 |
|---|---|---|
| 未安装 dsh-im | `not-installed` | **静默**降级到浏览器/桌面通知；设置页显示一行安装引导 |
| 已装但没目标/没选 | `not-configured` | 同上 + 设置页提示「请先在 dsh-im 里给机器人发一条消息，再回来选择投递目标」 |
| 机器人掉线 | `channel-offline` | 记 `task_events` + 页面横幅「微信通道断开」；**队列保留**，恢复后合并补发 |
| 被 iLink 拒发 | `failed` | **触发熔断**（见设计 2 §4）；队列保留并合并 |
| 软预算超限 | `throttled` | 队列保留，`retryAfterMs` 提示下次可发时间 |

**降级不是"什么都不做"**：`not-installed` / `not-configured` 时，提醒仍然按现有前端链路（页面横幅 + 桌面通知）弹出——即**降级 = 回到今天的行为**，而不是丢提醒。

---

## 5. 错误归一化

dsh-im 的 `send()` reject 时带 `error.code`，映射表：

| dsh-im code | 归一化 reason | 是否可重试 | 备注 |
|---|---|---|---|
| `bot-not-connected` | `channel-offline` | ✅ 可重试 | 机器人离线 |
| `delivery-failed` | `failed` | ⚠️ **触发熔断** | iLink 拒发（额度/风控），不可快速重试 |
| `unknown-bot` / `unknown-target` | `not-configured` | ❌ | 配置失效，需用户重选 |
| `target-rejected` | `failed` | ❌ | 平台明确拒绝 |
| `bad-request` | `failed` | ❌ | 调用方 bug，记日志 |
| `cancelled` | `failed` | ✅ | AbortSignal 触发 |
| 其他/未知 | `failed` | ⚠️ 保守 | 记 detail 原文 |

**判定依据**：`delivery-failed` 是唯一触发熔断的码——实测它的底层是 `provider=-2 / send-rejected`，且**静置 5 分钟不恢复**。

---

## 6. 队列持久化

队列必须**重启不丢**（否则补发机制形同虚设）。落在工作台自己的库里：

```sql
CREATE TABLE IF NOT EXISTS reminder_queue (
  id            TEXT PRIMARY KEY,
  reminder_id   TEXT,              -- 幂等键，可空（合并摘要为空）
  root_task_id  TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  priority_code TEXT NOT NULL,
  due_at        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
```

- 合并摘要（多条积压合成一条）用一行表示，`reminder_id = NULL`，`body` 里列出条目；
- 队列**不存** botId/targetId（目标在发送时解析，用户换目标后旧队列自动跟新目标）；
- 队列上限 200 行，超出丢弃最旧并记事件（防极端情况无限增长）。

---

## 7. 验收标准（本设计的可验证点）

1. 未安装 dsh-im：`available() === false`，`send()` 返回 `not-installed`，**不抛错**；
2. 未配置目标：返回 `not-configured`，且设置页给出可操作提示；
3. 发送成功：返回 `{ ok: true }`，队列行删除；
4. `delivery-failed`：返回 `failed` 且熔断开启，后续发送直接返回 `throttled` 不发网络请求；
5. 队列跨重启保留（写库，进程重启后仍在）。
