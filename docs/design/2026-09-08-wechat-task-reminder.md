# 工作台任务提醒接入微信 · 技术方案

> **文档状态**：头脑风暴定稿，任务树已创建，**代码尚未开始**
> **定稿日期**：2026-09-08
> **来源点子**：`cd66eb63-4ffb-4cea-b92f-caddd7c62397`（工作台插件的任务提醒功能能否绑定微信）
> **主任务**：`2da8c5bb-30fb-4fba-b3f7-e5cecb513737`（工作台任务提醒接入微信（可选增量能力））

---

## 0. 给后续 Session 的快速上手

**先读第 2 节「结论」，那 6 条是全部决策，其余章节是论证过程。**

- 当前进度：任务树已建（21 个任务），**一行代码都还没写**。
- **第 0 步（前置）：把本机 DSH 升级到 `0.1.2-rc.1`** —— 详见 §7.1。一次升级同时解决「工作台 v1.10.1 客户端 API」「dsh-im 声明兼容」「最大风险」三件事。
- 第一件事：做「Phase 0」——实测 `dsh-im` 能否在本地跑通。**这是闸门，跑不通就要重评方案。**
- 三个禁止事项（都是踩过坑得出的）：
  1. **不要自建 iLink 客户端**（协议、凭证、限流全是坑，生态里已有成熟实现）。
  2. **不要静态声明 `inject: ['dshIm']`**——未安装时会导致宿主 pending、启动阻塞。
  3. **不要绕过节流**——个人微信有风控，刷屏会被限制。

---

## 1. 需求

### 1.1 用户诉求

1. 工作台里任务的到期提醒，能推到**手机微信**上；
2. **后续可能**希望"在微信里操作工作台"（如查今天任务、标记完成）；
3. **不配置微信也要能正常使用工作台**——微信是可选增量，不是硬依赖。

### 1.2 现状（改造前）

工作台插件的提醒链路**完全在前端**：

```
浏览器页面（每 5 秒轮询） → GET /api/workbench/reminders/due
   → 页面横幅 + new Notification(...) 桌面通知
```

关键事实：

| 项 | 现状 |
|---|---|
| 触达前提 | **浏览器页面必须开着**，关掉就完全不提醒 |
| `task_reminders` 表 | 有 `offset_minutes` / `method_code` / `enabled` / `fired_at` |
| `reminder_method` 字典 | 只有 `browser` 可用（`os` 标记 `allowedV1: false`） |
| 添加提醒 | 客户端写死 `methodCode: 'browser'` |
| 触发标记 | `fireReminder()` 写 `fired_at` |

**结论：要"关着浏览器也能收到微信提醒"，必须把调度搬到 host 侧。**

---

## 2. 结论（6 条决策）

| # | 决策 | 理由摘要 |
|---|---|---|
| 1 | **微信没有"给任意用户主动推送"的 AI 接口** | AI 是内容层，通道是另一层，必须分开 |
| 2 | **通道层不自建，复用 `@xmanrui/dsh-im`** | 生态里唯一"微信出站 + 插件级 API + 高成熟度" |
| 3 | **不做硬依赖，用 `ctx.get('dshIm')` 软探测** | cordis 源码确证可行；未装时静默降级 |
| 4 | **调度用 DSH 自带的 `ctx.interval()`** | 随 fiber 自动销毁，比裸 `setInterval` 安全 |
| 5 | **节流是硬需求**（≤6 条/小时、≤50 条/日，超限排队） | 个人微信风控；借鉴 lanbaolu 的实测参数 |
| 6 | **必须做启动补发（catch-up）** | host 定时器在 DSH 关闭期间不跑，否则静默丢提醒 |

**范围**：本期只做**单向提醒**。"微信里操作工作台"（双向）不在范围内，但通道选型已为它留好路（见 §8）。

---

## 3. 生态调研（为什么是 dsh-im）

### 3.1 调研方法

- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 全量 **3408 个插件**，其中 **Notifications & Integrations 分类 137 个**，全部解析排名；
- 对 11 个候选**下载源码逐个验证**（`ctx.provide()` / 主动推送接口 / 微信能力）；
- 检查本地 profile 的**全部 `@deepseek-ai/*` 包**，发现两个内置服务（§4.2、§4.3）。

### 3.2 关键否决：dsh-notifier 的微信是「纯入站」

`THEWOLFWALKER/dsh-notifier`（★89、27 通道、1531 测试）本来是最佳通道层候选，**但它的微信通道推不了消息**。三条源码证据：

```js
// src/config.mjs —— 出站 adapter 注册表里没有 wechat
export const ADAPTERS = Object.freeze({
  telegram, dingtalk, feishu, wxpusher, pushplus, serverchan,
  bark, webhook, bell, desktop, ...SPEC_ADAPTERS,
  'qq-bot': qqBot, 'wecom-app': wecomApp,
})
```

```js
// src/inbound/capability-matrix.mjs
// 再查同名（如 wechat 没有对应出站 adapter——返回 null）
```

```js
// src/control/router.mjs
// 编号话术经入站 sendText 送达（纯入站通道如 wechat iLink 没有出站文本可走）
```

另外它自己的能力矩阵也诚实标注：

```js
// src/channels/wechat-ilink/index.mjs
export const WECHAT_ILINK_CAPABILITIES = Object.freeze({
  sessionExpiryRescan: 'contract-tested',   // 会话过期 = 重新扫码
  realDeviceVerified: false,                // 真机未验证
})
```

**所以 `ctx.notifier.push()` 永远推不到微信**。它只能回复你发给机器人的消息。这也解释了为什么它的出站渠道推荐列表（Bark/Telegram/钉钉/飞书/企微/桌面）里唯独没有微信。

### 3.3 候选横向对比

| 插件 | 星 / 30天下载 | 许可 / 发布 | 微信**出站** | 插件级接口 | 成熟度 |
|---|---|---|---|---|---|
| **xmanrui/dsh-im** | **1215 / 36k** | MIT / npm | ✅ 个人微信 | ✅ `ctx.dshIm.send()` + HTTP + RPC | **v4.16.1（2026-09-09）** |
| THEWOLFWALKER/dsh-notifier | 89 / 10k | MIT / npm | ❌ 纯入站 | ✅ `ctx.notifier.push()` | 1531 测试 |
| lanbaolu/dsh-wechat-bridge | 5 | MIT / github | ✅ 个人微信 | ⚠️ daemon HTTP 端点（token 鉴权） | v0.9.0 |
| Carl-5535/dsh-wechat-gateway | 3 | MIT / github | ✅ 个人微信 | ✅ `ctx.get('wechat').notify()` | v0.1.0 |
| wssfk12138/dsh-wechat-notify | 10 | MIT / github | ✅ | ❌ 仅 `wechat_notify` 工具 | v0.2.0 |
| pan17/dsh-wechat | 9 | MIT / npm | ✅ | ❌ 仅 `send_wechat` 工具 | 多测试 |
| wsz987/dsh-channels | 11 | — | ✅ | ⚠️ `ctx.channels` + `send_channel_message` 工具 | v0.4.2 |
| BiBoyang/dsh-im-bridge | 9 | MIT / github | ✅ | ❌ 仅事件推送 | v0.1.0 |
| MichengAI/dsh-im-connect | 15 / 8k | Apache-2.0 | ✅ | ❌ 未发现服务 | v0.1.38 |

**唯一同时满足「微信出站 + 文档化插件级 API + 高成熟度」的是 `xmanrui/dsh-im`。**

### 3.4 选定方案：`@xmanrui/dsh-im`

| 项 | 事实 |
|---|---|
| 包名 / 版本 | `@xmanrui/dsh-im` v4.16.1（2026-09-09 发布，两天前仍在更新） |
| 热度 | ★1215、30 天下载 36,125 |
| 许可 / 发布 | MIT、npm 公开包 |
| 引擎 | Node >= 22.19（本地 v24.19.0 ✓） |
| 通道 | 9 个：**微信**、企业微信、钉钉、飞书、QQ、Slack、Telegram、Discord、WhatsApp |
| 微信能力 | 腾讯 iLink 长轮询**收发**消息（双向） |
| 主动投递 | 9 个渠道全部支持，官方文档 `PROACTIVE_DELIVERY.md` |

**插件级调用（源码确证）：**

```js
// 源码：ctx.provide('dshIm', Object.freeze({ send, listTargets, listBots }))
const notifier = ctx.get('dshIm')          // 软探测，无需 inject 声明
await notifier.send(botId, targetId, '任务到期：跟客户 A 开会', { signal })
```

**另外两条备选路径**（同一投递核心）：

```bash
# HTTP（回环、无鉴权、复用 DSH WebServer，不另开端口）
POST http://127.0.0.1:3080/api/dsh-im/delivery/messages
{ "botId": "...", "targetId": "...", "text": "..." }   → { "sent": true }
```

```js
// Connection RPC
connection.rpc.call('/dsh-im-delivery', 'message.send', { botId, targetId, text })
```

**关键设计**：用稳定的 **`botId + targetId`** 抽象目标，不需要 sessionId / chatRef / 消息 ID。`targetId` 是调用方自定义别名（保存后不可改），平台原生 ID 可以改而调用方不变。

**错误码**：`bot-not-connected` 等；失败时 Promise reject，`error.code` 可用。

### 3.5 值得借鉴：lanbaolu 的节流设计

`lanbaolu/dsh-wechat-bridge`（★5）虽然不宜作为底座（守护进程架构 + 无插件服务），但它的**风控设计最专业**，源码 `notify.ts` / `api.ts`：

- **每小时 ≤6 条、每日 ≤50 条**，超限进**待补发队列**延迟发送；
- 另有**熔断器**（`CIRCUIT_THRESHOLD`，基于限流事件窗口）；
- 注释明确写着目的是「**规避个人号风控**」。

这套参数直接抄进工作台的策略层（§5.3）。

---

## 4. 技术底座（已源码验证）

### 4.1 软探测 `ctx.get()` 是官方支持的

文件：`@deepseek-ai/cordis@4.0.1` → `src/reflect.ts`

```ts
// L9-19 类型声明原文
/**
 * Read a service from the store **without the inject requirement**.
 * @returns the service value, or `undefined` when not (yet) provided.
 */
get(name: string, strict?: boolean): any
```

```ts
// L233-243 实现
get(name: string, strict = true) {
  return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
}
_getImpl(name: string, strict = true) {
  const key = this.ctx[symbols.isolate][name]
  const impl = key && this.store[key]
  if (!impl) return          // ← 没装就返回 undefined，不抛错
  ...
}
```

**关键区分**：

| 写法 | 行为 |
|---|---|
| `ctx.get('dshIm')` | ✅ 安全软探测，未提供返回 `undefined` |
| `ctx.dshIm`（属性访问） | ❌ 未声明 inject 时**直接抛错**：`cannot get property "dshIm" without inject`（L144 的 Proxy 陷阱） |

**推论**：`inject: ['dshIm']` 静态声明会导致未安装时宿主 pending、**阻塞启动**（dsh-notifier 的 `PLUGINS.md` 明确写了这一点）。所以工作台**不能**静态声明，必须软探测。

### 4.2 定时器用 `ctx.interval()`，不要裸 `setInterval`

本地已装 `@deepseek-ai/cordis-plugin-timer@1.1.4`，它把定时能力混入每个 context：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    timer: TimerService
  }
}
```

`ctx.interval(cb, delay)` **随 fiber 自动销毁**，比手写 `setInterval` + 清理更不容易漏。

### 4.3 为什么不用 `dsh-schedule`

本地有官方包 `@deepseek-ai/dsh-schedule@0.1.1-rc.2`：

> "Agent-scoped **durable** after, at, and fixed-rate reminders over the session event log"

- 三种规则：`after`（延迟）/ `at`（绝对时间）/ `every`（固定频率，最小 300 秒）；
- **durable**（写在会话事件日志里，重启不丢）；
- 但它是 **agent-scoped + 工具式**：触发方式是**往会话注入一条 prompt**，即**要跑一个 LLM 回合**。

**提醒不该烧 token**，所以不用它。但它证明了「durable」是必要设计 → 我们用「自己的 DB + 启动补发」实现等价效果。

### 4.4 本地环境事实

| 项 | 值 |
|---|---|
| **本机 DSH** | `@deepseek-ai/dsh@0.1.1-rc.2`（global 与 profiles/node_modules 一致）⚠️ **落后** |
| npm 最新 DSH | `0.1.2-rc.1`（`latest` tag）；另有 `0.1.5-alpha.1`（`alpha` tag） |
| 工作台插件仓库 | 已同步到 **v1.10.1**（`d3906fd`）；其客户端已适配 **DSH 0.1.2**（`connection.generation.host` / `uiWorkspace.connectWorkspace`，commit `f0adc53`） |
| profile 实际安装 | `@dely0/dsh-personal-workbench@1.9.0`（落后于仓库 v1.10.1） |
| Node / npm | v24.19.0 / 11.17.0 |
| profile | `web` |
| 已装相关插件 | `dsh-pocket@^2.8.0`（手机远程访问 DSH Web UI，已具备） |

---

## 5. 目标架构

### 5.1 总览

```
┌─ 工作台插件（host，硬依赖仍为 webServer / systemPrompt / tools）────────┐
│                                                                        │
│  ① 到期扫描调度器   ctx.interval(30s) → 查 task_reminders 到期未触发     │
│         ↓                                                              │
│  ② 提醒策略层       分级（P0/P1 即时、P2/P3 汇总）· 静默时段 · 节流 · 补发 │
│         ↓                                                              │
│  ③ ChannelAdapter   薄适配层（软探测，~50 行）                          │
│         ├─ ctx.get('dshIm') 可用 → send(botId, targetId, text)         │
│         └─ 不可用 → 降级到现有浏览器/桌面通知（今天的默认行为）           │
│         ↓                                                              │
│  ④ 结果回写        成功写 fired_at；失败写 task_events + 页面横幅提示     │
└────────────────────────────────────────────────────────────────────────┘
                            ↓
                    @xmanrui/dsh-im
                     └→ 微信个人号（iLink）→ 手机微信
```

### 5.2 ChannelAdapter 契约（设计提案）

```ts
interface ChannelAdapter {
  readonly id: 'wechat'
  /** 每次发送前软探测，支持"后装 dsh-im" */
  available(): boolean
  /** 永不 reject；失败在返回值里体现 */
  send(msg: { title: string; content: string }, opts: { signal?: AbortSignal }): Promise<SendResult>
}

type SendResult =
  | { ok: true; delivered: true }
  | { ok: false; reason: 'not-installed' | 'not-configured' | 'channel-offline' | 'throttled' | 'failed'; detail?: string }
```

**三种降级场景（用户可见口径已定）**：

| 场景 | 行为 |
|---|---|
| 未安装 dsh-im | **静默降级**到浏览器/桌面通知；设置页显示**一行**安装引导（含安装命令） |
| 已安装但未配目标 | 同降级 + 提示「请先在 dsh-im 设置里配置投递目标」 |
| 发送失败（如 `bot-not-connected`） | 记 `task_events` + 提醒横幅提示「微信通道断开」；按策略重试 |

### 5.3 策略模型（默认值，用户可覆盖）

| 项 | 默认值 | 说明 |
|---|---|---|
| 即时推送分级 | P0 / P1 | 到期立刻推 |
| 汇总分级 | P2 / P3 | 每日汇总成一条 |
| 每日汇总时间 | 09:00 | 可配 |
| 静默时段 | 22:00–08:00 | 静默期内不即时推，并入次日汇总 |
| 每小时上限 | **6 条** | 抄 lanbaolu 实测值 |
| 每日上限 | **50 条** | 同上 |
| 超限行为 | 进队列延迟发送 | 不丢消息 |
| 覆盖优先级 | 任务级 > 全局 | |

### 5.4 幂等与补发

- **幂等键**：`reminderId`（`task_reminders.id`），成功才写 `fired_at`；
- **与前端互斥**：host 已推送的 reminder，前端轮询不再重复弹（靠 `fired_at` 或独立标记）；
- **启动补发**：插件启动时扫描 `due_at - offset < now AND fired_at IS NULL` 的记录，按策略补发；
  - 补发**必须有上限**（如最多合并成 1 条 + 最多 N 条），避免积了一周一次性刷屏。

---

## 6. 任务树（含工作台 id）

> 主任务 `2da8c5bb-30fb-4fba-b3f7-e5cecb513737` · 计划总估时 **1095 分钟（约 18.25 小时）**
> ⚠️ 工作台里 `estimated_minutes` 目前为 NULL（见 §7.6 的 bug）

```
工作台任务提醒接入微信（可选增量能力）                      2da8c5bb…  1095m
├─ Phase 0：实测 dsh-im 可用性与版本兼容（闸门）            e061977d…  180m
│   ├─ 安装 @xmanrui/dsh-im 并扫码绑定个人微信              1fcb3a18…   90m
│   ├─ 验证主动投递接口（服务与 HTTP 两条路径）             891ab1c4…   60m
│   └─ 实测微信限流与失败模式并记录                        d69b8286…   30m
├─ 设计提醒策略层（分级 / 静默 / 节流 / 补发）               09dbf543…  195m
│   ├─ 定义 ChannelAdapter 契约与降级语义                  dabe0fe4…   90m
│   ├─ 设计分级 / 静默 / 节流策略模型                      43f7031e…   60m
│   └─ 设计启动补发（catch-up）与幂等语义                   0a749ddc…   45m
├─ 实现 host 侧常驻提醒调度器                              e01beda0…  240m
│   ├─ 用 ctx.interval() 实现扫描-分发循环                 e62d8b4d…  120m
│   ├─ 启动补发与幂等去重                                  c33f6681…   60m
│   └─ 推送结果回写与失败提示                              763e2eb3…   60m
├─ 实现 dsh-im 通道适配层与节流                            9d1ea281…  240m
│   ├─ ChannelAdapter 实现（软探测 + send + 错误分类）      d5d3cf2a…  120m
│   ├─ 节流与延迟发送队列                                  41195a0a…   90m
│   └─ 降级到现有浏览器/桌面通知 + 设置页引导               b256f802…   30m
└─ 策略配置界面与端到端验收                                69d5c1f2…  240m
    ├─ 推送策略配置界面                                    c787a5de…  120m
    ├─ 端到端验收：关浏览器也能收到微信提醒                2b5fb11e…   60m
    └─ 回归：未装 dsh-im 的完整体验                         6717d3e5…   60m
```

### 6.1 三条必须钉住的验收标准

> **缺失的一步**：任务树里没有「升级本机 DSH 到 0.1.2-rc.1」这个动作（见 §7.1）。建议开工前补一个前置任务，或把它并入「Phase 0」的第一个子任务。

1. **Phase 0.2**：验证「未安装 dsh-im 时 `ctx.get('dshIm')` 返回 `undefined` 且**工作台能正常启动**」——这是「不做硬依赖」的技术底线。
2. **端到端验收**：设 2 分钟后到期的 P1 任务 → **完全关闭浏览器** → 手机微信收到；重复 3 次。
3. **回归**：卸载 dsh-im 后工作台正常启动、原有提醒仍工作、设置页显示引导；重装后无需改代码恢复微信推送。

---

## 7. 风险与待验证点

### 7.1 ⚠️ 最大风险：本机 DSH 版本落后（已有明确解法）

| | 版本 |
|---|---|
| dsh-im 声明兼容 | `0.1.2-alpha.4` / `0.1.2-alpha.5` / `0.1.2-rc.1` / `0.1.3-alpha.1` |
| 工作台 v1.10.1 客户端目标 | **DSH 0.1.2**（commit `f0adc53`：适配 `connection.generation.host` 与 `uiWorkspace.connectWorkspace`） |
| **本机实际** | **`0.1.1-rc.2`** ← 两条都对不上 |

**解法：先把本机 DSH 升级到 `0.1.2-rc.1`（npm `latest`）。** 一次升级同时解决三件事：

1. 工作台 v1.10.1 客户端在 0.1.1 上启动 AI 会话会报 `Cannot read properties of undefined (reading 'getSnapshot')`（见 `f0adc53` 提交说明）；
2. 满足 dsh-im 的声明兼容范围，消除通道层最大的不确定性；
3. 与另一台机器（已完成 0.1.2 适配）保持一致，避免"两台机器行为不同"。

**升级后必须回归**：工作台的 AI 澄清 / 拆解 / 执行 / 计划 / 报告会话能否正常启动（这正是 `f0adc53` 修的路径）。

> 若因故无法升级，本方案需重新评估——dsh-im 的兼容声明不在 0.1.1 范围内，硬装失败风险较高。

### 7.2 `context_token` 前提

iLink 主动推送需要 `context_token`，而 dsh-im 的投递目标只能从「**已聊过的会话**」里创建。**意味着必须先给机器人发过一条消息**，否则主动推送可能不生效。

### 7.3 个人微信风控

- iLink 服务端限流约 **7 条 / 5 分钟**（社区实测）；
- 个人号风控阈值未知，**节流是硬需求**（§5.3 的参数即为对冲）。

### 7.4 dsh-im 的微信通道真机成熟度未知

dsh-notifier 至少提供了 `realDeviceVerified: false` 的诚实标注；**dsh-im 没有对应的能力矩阵**，所以"能不能稳定推"只能靠 Phase 0 实测。

### 7.5 依赖体量

dsh-im 的 dependencies 包含 `@tencent-connect/qqbot-connector`、`@wecom/aibot-node-sdk`、`dingtalk-stream`、`undici`、`qrcode`——比 dsh-notifier（零依赖）重。安装前留意 profile 的依赖体积与构建脚本限制（pnpm ≥10 需 `onlyBuiltDependencies`）。

### 7.6 顺带发现的工作台自身问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | `workbench_submit_idea_tasks` 的 `estimated_minutes` **确认后丢失**（草稿 payload 里有值，任务表里是 NULL） | 规划时看不到估时 |
| 2 | 同一份 idea 草稿可被**重复确认**，导致任务树重复创建（本次产生了 41 个任务，已清理 20 个） | 数据污染 |
| 3 | 工作台**没有删除任务的路由**（只有 `archiveTask`），清理只能改 DB | 误建任务难清理 |
| 4 | 客户端**不支持拖拽改父级**、也没有"修改父任务"入口 | 结构错了只能重建 |

---

## 8. 范围外（但已留路）

**「在微信里操作工作台」（双向）** 不在本期范围，但通道选型已经为它留好路：

```
微信 → dsh-im 入站通道 → DSH agent → 工作台已有工具（workbench_*）
```

工作台**一行微信代码都不用写**——它已经注册了全套 `workbench_*` 工具。真正的门槛是**入站通道选择**：

| 入站通道 | 需要什么 |
|---|---|
| 微信个人号 iLink | 扫码（零公网、零成本）✅ |
| WxPusher | **公网 HTTPS 回调** ❌ |
| 飞书 / QQ / 钉钉 | 扫码（不是微信） |

选 dsh-im 的原因之一正是它同时提供入站，未来做双向无需换底座。

---

## 9. 本次已执行的数据清理（备查）

| 项 | 内容 |
|---|---|
| 背景 | 旧草稿（5 个平铺任务）与新草稿（1 主任务 + 子树）都被确认，产生 41 个任务 |
| 处理 | 删除旧树的 20 个任务（5 根 + 15 子），保留新树 21 个 |
| 安全检查 | ①旧根必须正好 5 个；②20 个任务的事件全部为 `created`；③新树完整性预检 |
| 删除方式 | 事务内先子后父；`foreign_keys = ON` 级联 `task_events` |
| 校验 | 剩余 21 个任务、1 个根、0 个孤儿 |
| 备份 | `~/.dsh/workbench/backup_before_cleanup_2026-09-08T17-21-46-065Z/`（含 `VACUUM INTO` 快照 + 原始三文件） |

---

## 10. 参考资料

### 选定的底座
- [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im) — 9 通道 IM 桥
- [主动投递使用指南（PROACTIVE_DELIVERY.md）](https://github.com/xmanrui/dsh-im/blob/main/PROACTIVE_DELIVERY.md) — `ctx.dshIm.send()` / HTTP / RPC 三种调用方式

### 调研过的候选
- [`THEWOLFWALKER/dsh-notifier`](https://github.com/THEWOLFWALKER/dsh-notifier) — 27 通道通知总线（微信纯入站）
- [`lanbaolu/dsh-wechat-bridge`](https://github.com/lanbaolu/dsh-wechat-bridge) — 节流设计参考
- [`pan17/dsh-wechat`](https://github.com/pan17/dsh-wechat) — 微信当 DSH 第二客户端
- [`Carl-5535/dsh-wechat-gateway`](https://github.com/Carl-5535/dsh-wechat-gateway) — `ctx.get('wechat').notify()`
- [`wssfk12138/dsh-wechat-notify`](https://github.com/wssfk12138/dsh-wechat-notify) — `wechat_notify` 工具
- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) — 3408 插件索引

### 背景
- [OpenClaw 微信渠道文档](https://docs2.openclaw.ai/zh-CN/channels/wechat) — ClawBot / iLink 协议背景
- [`@claw-lab/wxclawbot-cli`](https://github.com/lroolle/wxclawbot-cli) — iLink 主动推送的社区实现（含限流/context_token 说明）
