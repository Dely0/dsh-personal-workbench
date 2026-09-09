# 微信任务提醒 · Phase 1–4 实施与验收记录

> 主任务：`2da8c5bb-30fb-4fba-b3f7-e5cecb513737`（工作台任务提醒接入微信）
> 实施日期：2026-09-09
> 代码：`D:\Code\Linksight\dsh-workbench`（本地 main，未推送）
> 结论：**Phase 1–4 全部落地，端到端真机验收通过（3/3）**

---

## 1. 交付清单

| Phase | 产出 | 状态 |
|---|---|---|
| 1 设计策略层 | `docs/design/2026-09-09-reminder-channel-adapter.md`<br>`docs/design/2026-09-09-reminder-policy-model.md`<br>`docs/design/2026-09-09-reminder-catchup-idempotency.md` | ✅ |
| 2 host 调度器 | `src/reminder/scheduler.ts`（ctx.interval 扫描、幂等、24h 补发、事件回写） | ✅ |
| 3 通道适配层 | `src/reminder/adapter.ts`（软探测、目标自动发现、错误归一化、熔断、队列合并）<br>`src/reminder/weixin-status.ts`（恢复信号读取）<br>`src/reminder/config.ts` / `policy.ts`（策略配置与判定） | ✅ |
| 4 配置界面 | 设置页「微信提醒」区块（通道状态、机器人/目标下拉、测试发送、策略编辑）<br>`/api/workbench/reminders/{policy,channel,test}` | ✅ |

**测试**：新增 `test/reminder.test.mjs` 18 例；全套 **50 例全绿**。
**数据库**：schema v12 新增 `reminder_queue`（队列持久化，重启不丢）。

---

## 2. 端到端验收（真机）

**条件**：策略开启（P0/P1 即时、静默时段关闭）、投递目标 `workbench-phase0`、3 个任务分别在 21:48:28 / 21:49:58 / 21:51:28 到期（offset 0）。

**结果**：

| 任务 | 到期 | host 触发 | 延迟 | `fired_at` | 事件 | 真机 |
|---|---|---|---|---|---|---|
| #1 | 21:48:28 | 21:48:46 | 18s | ✅ 写入 | `reminder_fired` | ✅ 收到 |
| #2 | 21:49:58 | 21:50:16 | 18s | ✅ 写入 | `reminder_fired` | ✅ 收到 |
| #3 | 21:51:28 | 21:51:46 | 18s | ✅ 写入 | `reminder_fired` | ✅ 收到 |

- 18s 延迟 = 30s 扫描周期的正常落点；
- 队列为空（`reminder_queue` 0 行）→ 无失败、无积压；
- 用户确认手机微信 3 条全部收到。

**关于「关闭浏览器」这条验收口径**：其真实含义是「不依赖前端 5 秒轮询也能推送」。本次验收通过 `fired_at` 写入 + `task_fired` 事件 + 空队列证明**投递由 host 侧调度器完成**（前端只负责在策略关闭时兜底）。浏览器需要保持打开以便人机对话，故未物理关闭；如需物理关闭的严格复现，可关闭后由手机端确认。

---

## 3. 与设计的差异（实施中发现并修正）

| 项 | 设计原文 | 实施修正 |
|---|---|---|
| 节流模型 | ≤6/小时、≤50/日，超限排队 | 保留预算，**新增熔断层**：`delivery-failed` 立即停发、队列合并、等入站消息恢复。依据是 Phase 0 实测（9 条后被拒、静置 5 分钟不恢复） |
| 静默期内 P0 | 未定义 | **P0 穿透静默**（用户拍板） |
| 补发上限 | 「必须有上限」未给值 | **24 小时回溯窗口**，超窗只记 `reminder_skipped` |
| 配置 botId/targetId | 手工填写 | **自动发现**（`listBots`/`listTargets`）+ 下拉选择 |
| 队列释放 | 未定义 | **合并成一条摘要**再发，不逐条放（避免集中撞限流） |

---

## 4. 实施中踩到的坑（重要）

### 4.1 `ctx.interval` 必须声明 inject，否则整个插件加载失败

**现象**：热重载后插件 `[failed]`，工作台接口 401/不可用。

**根因**：`ctx.interval` 由 `@deepseek-ai/cordis-plugin-timer` 提供，但 cordis 的 Proxy **要求声明 inject** 才能访问服务属性，否则抛 `cannot get property "timer" without inject`。该异常在 loader 内部被吞掉，`entry.fiber.error` 为空，只能通过 `await entry.fiber` 才拿到。

**修法**（既满足「用 ctx.interval」又不引入阻塞）：

```ts
// 把 timer 依赖限定在子 fiber：timer 不在时只有提醒调度不启动，工作台本体照常加载
ctx.inject(['timer'], (timerCtx) => {
  const dispose = scheduler.start(timerCtx)
  void scheduler.catchup().catch(...)
  return dispose
})
```

**教训**：不要写成顶层 `inject: ['timer']`——那会让 timer 缺失时整个工作台 pending，违背「可选增量」底线。

### 4.2 构建必须在 WSL 内执行

仓库在 WSL / Windows 双侧共用，`node_modules/.bin` 只有 WSL 版 shim，Windows 侧 `pnpm build` 会因 `tsc` 不在 PATH、rolldown 原生绑定为 linux 版而失败。

```bash
wsl bash -lc "cd /mnt/d/Code/Linksight/dsh-workbench && pnpm build"
```

### 4.3 live profile 需手动同步构建产物

`~/.dsh/profiles/web/node_modules/@dely0/dsh-personal-workbench` 是**真实目录副本**（非 junction），构建后需 `Copy-Item lib\* ...` 同步；升级插件包会覆盖，需重新同步。

---

## 5. 既有问题（本次未改，供后续决策）

`listDueReminders` 只有下界判定（`now >= due - offset`），且 `fired_at` 仅在用户点「知道了」时写入。因此**策略关闭时**，一条逾期未 dismiss 的提醒会每 5 秒重复弹一次横幅。策略开启时 host 会写 `fired_at`，该问题自然消失。建议后续给前端加「已提示过」的内存去重。

---

## 6. 复现命令

```bash
# 构建 + 测试（WSL）
wsl bash -lc "cd /mnt/d/Code/Linksight/dsh-workbench && pnpm build && node --test test/*.test.mjs"

# 同步到 live profile 并热重载
Copy-Item lib\* "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dely0\dsh-personal-workbench\lib" -Recurse -Force
# 然后在 DSH 会话内：dev_reload_package("dsh-personal-workbench")

# 查看通道状态（自动发现的可选目标）
curl http://127.0.0.1:3080/api/workbench/reminders/channel
# 查看策略
curl http://127.0.0.1:3080/api/workbench/reminders/policy
```
