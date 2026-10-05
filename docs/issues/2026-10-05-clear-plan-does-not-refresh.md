# INCIDENT：清除某日计划不刷新 —— 在「今日」实例上「清除了、界面却还在」

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-10-05（用户实测报告："清除今日计划并不会刷新页面，工作台页面在清除今日计划后还是存在今日计划卡片页面和被排期的任务"） |
| **严重级别** | P2（界面假象：数据已删、界面仍显示；手动刷新页面即恢复；**无数据损失**） |
| **触发动作** | 在**今日**实例的「计划」页签，点计划卡页脚的「清除」→ 确认（`src/client/components/PlanPanel.tsx:382`） |
| **影响范围** | 客户端日期域；服务端 `DELETE /plans/:date` 正常（`src/api/routes/plans.ts:110-113` → `deleteDailyPlan`，回 `{ ok: true, deleted }`） |
| **修复位置** | `src/client/hooks/useDayWorkspace.ts`：`clearPlan` 补 `await refresh()`；同时删除同文件里**没接线**的第二份实现 `clearTodayPlan` |
| **验证** | `test/dayPanelWiring.test.mjs` 新增 1 条源码扫描判据（该文件 7/7 绿）；**反向变异已实测**：去掉那行 `await refresh()` → 该条变红；全量 `pnpm test` 993/994（唯一红是本仓库注释里已记录过的 Windows 清理期假失败，见 §5） |

---

## 1. 现象

在「今日」实例上点「清除」后，**今日计划卡片、卡片里的计划项、容量账本、以及那些"被排期"的任务全部照旧**；手动刷新页面后才消失。在日历视图里清除某一天的计划则**正常**。

## 2. 根因：一条写入口漏了 bootstrap 重拉；同一语义还有第二份实现

```
PlanPanel 页脚「清除」（src/client/components/PlanPanel.tsx:382）
  └─ onClear → DayPanel onClearPlan（src/client/components/DayPanel.tsx:190）
       └─ src/client/index.tsx:632  onClearPlan: () => void clearPlan(dayPanel.day)
            └─ useDayWorkspace.clearPlan（src/client/hooks/useDayWorkspace.ts:365）
                 ├─ DELETE /plans/:date              ← 服务端确实删了
                 └─ setPlanRefreshKey(v => v + 1)    ← 只驱动「日历视图选中日」的 pickedPlan
                      （那个 effect 的首行是
                        if (view !== 'calendar' || dayTab !== 'plan') { setPickedPlan(null); return }
                        —— 在「今日」实例上它整个 return，什么都刷不到）
                 ✗ 缺 await refresh()               ← todayPlan 来自 bootstrap，只有它会重拉
```

- `const todayPlan = bootstrap?.todayPlan ?? null`（`src/client/index.tsx:501`）；全仓只有 `refresh()` 重拉 `GET /api/workbench/bootstrap`（`src/client/hooks/useTaskData.ts:175-177`）。
- 连带（同一根因、同一时刻一起不刷）：容量账本（`src/client/hooks/useDayWorkspace.ts:266-276` 的 `computeTodayCapacity`）与「计划 / 未排期」页签成员（`src/client/dayPanelModel.ts`）都从 `todayPlan` 派生。
- **同一文件里当时还有一份没接线的** `clearTodayPlan`（`src/client/hooks/useDayWorkspace.ts:248-251`）：`DELETE` + `await refresh()` 写法是对的，但紧接着一句 `void clearTodayPlan`（252）把它丢掉。—— **同一语义两份实现：写对的那份没接线，接线的那份漏刷新**，正是本仓库第一 bug 类别（"同一个语义被独立计算多次"）的现场。
- 旁证（"就漏了这一条"）：同文件 `addTaskToPlan`（refresh 在 295）、`patchPlanItem`（324）、`savePlan`（355）、`deleteReport`（381）都有 `await refresh()`。

## 3. 修复

1. `clearPlan` 在 `DELETE` 之后补 `await refresh()`，**顺序先删后刷**（反了刷到的还是旧计划）。
2. 删掉没接线的 `clearTodayPlan` —— 留着它就是第三份实现，下次还会有人改错那一份。

## 4. 防回归（政策 = 会失败的测试）

`test/dayPanelWiring.test.mjs` 新增 1 条，三条断言：

1. **全仓只有一处计划 DELETE**：`count(DAY, /api\(`\/api\/workbench\/plans\/[^`]*`, \{ method: 'DELETE' \}\)/g) === 1`。
   ⚠️ 只数**计划**的 DELETE：同文件里 reports 的删除也是一条 `method: 'DELETE'`（实测总量是 3），拿总量当判据会把无关的删除算进来（初版就这么错过一次，报 `3 !== 1`）。
2. 这处 DELETE 必须落在 `clearPlan` 函数体内，且**先 DELETE 后 refresh**（`refreshAt > deleteAt`）。
3. 四条计划写入口（`addTaskToPlan` / `patchPlanItem` / `savePlan` / `clearPlan`）的函数体里都必须有 `await refresh()`。

判据落在**函数体**上，而不是"DELETE 的下一行"：两者之间允许放解释性注释（初版写成紧邻匹配，把"为什么必须重拉"的注释加上去之后立刻**假红**——判据不该绑定文本形态）。

**反向变异实测**：把 `clearPlan` 里那行 `await refresh()` 拿掉 → 该条变红，报 `clearPlan 必须 await refresh()：todayPlan 来自 bootstrap，只 bump planRefreshKey 在「今日」视图上什么都刷不到`；装回去 → 7/7 绿。

## 5. 验证与未覆盖（诚实范围）

- `node --test test/dayPanelWiring.test.mjs`：**7/7 绿**（含新增那条）。
- `pnpm test`（先 build 再全量 `node --test test/*.test.mjs`）：**994 条，993 通过 / 1 失败**。唯一失败是 `test/db.test.mjs` 的 "db migrations, dictionaries and task tree"：
  `Error: EPERM, Permission denied: \\?\<临时目录>\dsh-personal-workbench-db-*`，抛在 `finally` 的 `removeTempDir`（`test/db.test.mjs:32-42` 已有 10 次重试），**所有断言都已跑过**——这正是该文件第 26-30 行注释里写明的"Windows 清理期假失败"。该文件不 import 任何客户端 hook，**隔离单跑同样复现**，与本次改动无关。
- 本轮**没有**做真浏览器实测：缺陷形态是"数据已删、界面陈旧"，修复是补一次与另外三条写入口同构的既有 `refresh()` 调用，界面层证据由源码扫描判据 + 变异探针承担。
- 未顺带修 `removeTempDir` 的重试耗尽问题（属测试脚手架，另开一次改动）。
