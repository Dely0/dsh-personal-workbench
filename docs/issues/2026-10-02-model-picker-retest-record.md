# #3「快速选择模型失效」复测记录（2026-10-02）

> **口径**：需求 §8.1 的「D 不修」条目 —— *按选过模型 → 重启/换会话 → 再提交复测（历史 v1.15.6/7 修复），
> 仍失效另记新 BUG*；**只留复现记录 + 上报决策，不改 `profiles/node_modules`**（宿主侧缺陷）。
>
> 本文件就是那条"复现记录"。

## 1. 结论

**未复现。** 在「选过模型 → 重载客户端 → 再提交」这条路径上，
v1.15.7 的修复（拿不到模型目录时**降级跟随默认模型并说清原因**、且保留界面内的清空出口）**有效**。
⇒ **无需另记新 BUG**；维持"不改宿主"的决策，记账为「已复测通过，继续观察」。

## 2. 复现方法（可重跑）

```powershell
# 目标实例：隔离测试实例（web profile / 3080）
$all = Select-String -Path "$env:TEMP\dsh-server-3080.log" -Pattern 'token=([A-Za-z0-9_.-]{20,})' | ForEach-Object { $_.Matches[0].Groups[1].Value }
$env:DSH_VERIFY_TOKEN = $all[-1]        # ⚠️ 取**最后一条**（日志里可能有多次启动的 token）
node scripts/repro/repro-model-picker-lock.mjs --url http://127.0.0.1:3080 --evidence-dir <目录>
```

脚本做的事，对应口径里的三步：

1. **制造"选过模型"**：往 `localStorage['dsh-personal-workbench.quickModelSelection']` 写入一个
   **形状合法但不存在**的选择 `{provider:'repro-nonexistent-provider', model:'repro-nonexistent-model', label:'复现用（不存在的模型）'}`。
   为什么这样就够：该键是"选过模型"**唯一的持久落点**（`ModelPicker.tsx#QUICK_MODEL_STORAGE_KEY`），
   "选过之后重启"到判定眼里与写入同一个值**完全等价**。
2. **重载客户端**（`goto` 带 token 的页面）：等价于"重启后第一次打开"（localStorage 保留、内存状态重建）。
3. **复测四个判据**（见下）。跑完**把 localStorage 还原回基线**（不留痕）。

## 3. 四条判据与实测结果

| # | 判据 | 历史失效时的表现 | 本次实测 |
|---|---|---|---|
| 1 | 点「快速录入」**能打开弹窗** | 完全没反应（`openQuickEntry` 第一行抛错） | ✅ 打开 |
| 2 | 模型下拉**能打开且给出可读原因** | 菜单打不开 / 只说"接口没提供" | ✅ 打开，列出 5 项（含「跟随 DSH 默认模型」），**无错误行** |
| 3 | 有**「跟随 DSH 默认模型」出口**且可用 | 门禁挡死，界面内清不掉残留选择 | ✅ 存在且 `disabled=false`（可点） |
| 4 | 提交**不抛错**，要么成功要么给出可读提示 | 抛错中断整条快速录入 | ✅ 对话框关闭、降级提示可见、`window.__reproErrors` 为空 |

原始观察（脚本输出，节选）：

```
基线：localStorage 里的模型选择：（无）
写入复现用的模型选择：{"provider":"repro-nonexistent-provider",...}
重载后选择仍在：true
点击「快速录入」：已点击
判据 1 · 弹窗是否打开：true
判据 2 · 菜单打开/可读原因：{"menuOpen":true,"menuError":null,"optionCount":5,"clearOptionPresent":true,"clearOptionDisabled":false}
判据 4 · 提交后：{"dialogStillOpen":false,"degradeNoticeShown":true,"errors":[]}
还原基线：true
结论：未复现（v1.15.7 的修复在这个形态下有效）
```

其中**降级提示**是本条修复的核心可见性：界面里出现了
`本次未切换模型，已按「跟随 DSH 默认模型」继续`（`QUICK_MODEL_DEGRADE_PREFIX`），
而不是静默失败或抛错 —— 与 v1.15.7 的验收标准一致。

证据：`repro-model-picker-lock.json` + `01-快速录入-弹窗.png` / `02-模型下拉.png` / `03-提交后.png`
（脚本会写进 `--evidence-dir`）。

## 4. 本次**没有**覆盖的形态（如实记，别当成"全测过了"）

| 未覆盖 | 为什么没做 | 风险 |
|---|---|---|
| 在 UI 里**真的点选一个模型**（而不是直写 localStorage） | 需要模型目录可用且选中一个真模型；结果状态与直写同一个键等价 | 低（持久化落点相同） |
| **切换宿主会话**（而不是页面重载） | 脚本用重载（客户端状态重建，更彻底）；换会话只影响宿主侧会话绑定 | 低 |
| **宿主模型服务不可用**（`ctx.get('modelDirectories')` 缺失）的形态 | 本机装了这个服务，无法在不改环境的前提下制造 | 中 —— 这条只能靠"降级路径有单测覆盖"（`test/modelPickerDegrade.test.mjs`）保证 |

## 5. 上报决策

- **不修改** `profiles/node_modules`（宿主侧代码），不向宿主仓库提交补丁 —— 与本任务的边界一致。
- 若后续在**用户正式实例**上再次观察到"选过模型后快速录入点不动 / 改不回默认模型"，
  **直接按本文方法跑一遍**该脚本：它会把四类判据与原始 DOM 读数一次拿到，
  比"再描述一遍现象"有用得多。
