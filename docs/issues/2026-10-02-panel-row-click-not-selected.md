# 冷启动客户端下，宿主「工作台」面板行的点击不生效（面板打不开）

> 发现于 2026-10-02 的**验收链重跑**（runId `20261002-015331-c19220` 等）。
> 状态：**已精确定位现象与证据链，未定性归属**（宿主侧时序 / 插件侧回归，需一次对照实验，见 §4）。
> 影响面：链里的 `legacy-duplicate-task`（LEG-D04）必红；任何"冷启动 + 需要打开面板"的自动化都会被卡住。
> **用户日常使用不受影响**（桌面端实测：入口点击正常；那条路径是真实鼠标 + 已初始化的宿主窗口）。

## 1. 现象（可复现）

冷启动一个**全新的浏览器 profile** → 打开 `http://127.0.0.1:3080/?token=…` → 侧栏**能看到**「打开工作台（任务 / 日历 / 知识库 / 点子）」这一行，
**真实鼠标点它的中心**（实测坐标 `x=139, y=138`，点中的正是该行，`textContent` 对得上），但：

| 观察项 | 点击前 | 点击后 1.5s | 点击后 4.5s |
|---|---|---|---|
| 面板行 `aria-current` / `aria-selected` | null | **null** | **null** |
| `[class*="frame"]` / `body` 上的选中相关属性 | 无 | **无** | **无** |
| `.wb-panel-host` 的 `data-open` | null | **null** | **null** |
| 插件 `data-dsh-personal-workbench-active` 计数 | 0 | **0** | **0** |

⇒ **宿主没有登记这次点击**：入口行自己的状态都没变（`aria-current` 仍为 null）。

对照：**同一个浏览器里，插件自己 UI 的按钮点击是生效的** —— 同一条套件里
`clickByText('确认入册')`、`clickByText('就用已有那条')` 都点成功，草稿卡片的交互正常。

## 2. 证据来源（都是可重跑的）

| 证据 | 位置 |
|---|---|
| 点击前后的完整事实快照 | `_local-build/diag-click.mjs`（一次性诊断脚本，gitignored） |
| 单独调用 `ensureWorkbenchPanel` 的中间事实 | `_local-build/diag-ensure.mjs` |
| 入口按钮本身的 DOM 事实 | `_local-build/diag-entry.mjs` → `{entryCount:1, rect:{w:252,h:36}, offsetParentNull:false, disabled:false}` |
| 那一刻的截图 | `test-results/workbench-verify/<runId>/suite-legacy-duplicate-task/01-panel-open.png`（侧栏展开、入口可见、主区仍是宿主欢迎页） |
| 链的判定 | 同 runId 的 `suite-legacy-duplicate-task.json`：`LEG-D04` 唯一失败，detail 见下 |

失败断言的 detail（**已把原因写进去**，不再只看 `{present:true,dataOpen:null,w:0}`）：

```
{"present":true,"dataOpen":null,"w":0}；等 data-open=1：15s 超时；入口点击：没找到按钮
```

## 3. 顺带修掉的两处**测试基建**缺陷（已改，都是"让失败可诊断"）

1. **`_harness.mjs#ensureWorkbenchPanel`**：
   - 旧版**只试一次** `clickByText`，冷启动首帧还没渲染就返回 `null` ⇒ 失败被记到"面板打不开"上，方向指错。
     现在**先等入口渲染出来**（默认 12s），等不到才认定侧栏被收起、才点开合按钮（顺序不能反 ——
     先判可见性会把"还没渲染"误判成"已收起"，反而**把展开的侧栏收起来**，我自己踩过这个坑）。
   - 新增 `clickSidebarToggleOnce`，注释里写明那个坑。
2. **`legacy-duplicate-task.mjs`**：
   - `waitFor(data-open=1)` 后面的 `.catch(() => undefined)` **删掉**，把"等到了吗"与"入口点击结果"写进 detail
     —— 这条正是本项目反复强调的"失败必须可观测、不许吞"。
3. **`legacy-sidebar-collapse.mjs`**：收尾把侧栏**还原成展开**
   （它的最后一步是刻意收起，脏状态会坑下一条套件；实测 `侧栏还原 = expanded`）。

## 4. 下一步（把它定性）

需要的是一次**对照实验**：把链跑到 **v1.16.0（批次2 之前）** 的产物上，看同一诊断是否同样"点击不生效"。

- 若 v1.16.0 也这样 ⇒ **宿主侧**行为（很可能与"新 profile 首次加载时 `layout` 尚未初始化"有关），
  记进 issue 并给链加"允许该条已知红"的登记（或换用宿主 API 选中面板）。
- 若 v1.16.0 正常 ⇒ **批次2 引入的回归**，按正常缺陷流程定位（静态排查已确认：本轮提交**没有触碰**
  `entryContract.ts` / `panelState.ts` / `constants.ts` / `capabilities.ts`，只动了 `index.tsx` 的视图层）。

对照实验的现成工具：`_local-build/diag-click.mjs`（换 `--url` 指向对照实例即可，注意 token 取**日志里最后一条**）。
