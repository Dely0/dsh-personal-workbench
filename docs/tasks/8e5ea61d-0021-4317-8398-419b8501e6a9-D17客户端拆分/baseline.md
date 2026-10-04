# D17 施工起点基线（P0）

> 度量口径：**去掉 CRLF 后的物理行数**（工具 `scripts/lib/d17-measure2.py`，按原始字节统计）。
> 历史文档里的 5697 / 4170 / 117 是**旧快照**，不是本次施工起点 —— 施工起点见下表"实测"列。

## 1. 施工起点标识

| 项目 | 值 |
|---|---|
| 仓库 | `D:\Code\Linksight\dsh-workbench` |
| 施工起点提交 | `f99bf77`（"专家功能升级调研文档"，2026-10-03） |
| HEAD 当时工作区状态 | `index.tsx` 与设计文档**无未提交改动**（`git status --short` 只有本轮新增的 `scripts/lib/d17-*.py`） |
| 包版本 | `package.json` = `1.16.2` |
| Node / 包管理 | 见 `package.json`（`tsdown 0.22.2` / `typescript ~5.7.2` / `react ^18.3.1`） |

## 2. 两项行数（出口判据的对照基准）

| 项目 | 实测施工起点 | P1 后 | 出口判据 |
|---|---|---|---|
| `src/client/index.tsx` 总行数 | **5725**（353277 字节，LF） | **5451**（341671 字节，CRLF）（Δ **-274**） | 最终 **<5697 且低于施工起点** |
| `WorkbenchApp` 本体行数 | **4197**（第 276–4472 行） | **3975**（第 224–4198 行）（Δ **-222**） | **结构硬门**（0 直接 state / 0 业务请求 / 0 定时器、单个顶层块 ≤80 行）+ 行数 **≤900 护栏**（[ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)；2026-10-04 起，原 **≤600** 降为努力目标） |

`WorkbenchApp` 边界用**大括号配对**测量（不把行号当迁移锚点）。P1 后起点前移是因为
知识域的 import 与顶层助手被删掉（import 区变短），这是正常的、可解释的位移。

> **最新度量（截至 P5-3，2026-10-04）**：入口 `src/client/index.tsx` = **3724 行**（施工起点 5725，累计 **-2001**）；
> `WorkbenchApp` = 第 **205–2471** 行、**2267 行**（施工起点 4197，累计 **-1930**）。
> 按 ADR-0008 的硬门，`WorkbenchApp` 体内 `setInterval` / `setTimeout` **均为 0**（P5-3 解锁，入口整份文件只剩
> 插件 setup 作用域的 `titlebarTimer`）；仍未清零的是直接 `useState` 声明 **27** 项、`api(`/`api<` 调用 **27** 处、
> `useEffect` **4** 条，以及 `fetch(` 0 处；最长顶层块 **500 行**（`const startAISession = async (…): Promise<void> => {`，
> 违反"不承载长 handler"，**随 P6 的 AI 会话域搬走**）。
> **逐批 before→after 与命令证据见 `verification.md`；本表只保留施工起点与 P1 两列。**

## 3. 状态计数（施工起点）

- `WorkbenchApp` 内**直接** `useState` 调用：**114**；全文件另有 2 处属于宿主组件的 tick 状态，合计 116。
- 设计文档 §4 逐项列出 114 项，并给出唯一 owner 映射；本目录 `ownership.md` 记录**实际迁移台账**。

## 4. 测试与构建基线

| 命令 | 施工起点实测 |
|---|---|
| `pnpm typecheck` | 退出码 **0** |
| `pnpm build` | 退出码 **0** |
| `pnpm test` | **984 条 / 983 通过 / 1 失败 / 0 跳过** |

唯一既有失败：

- 用例全名：`db migrations, dictionaries and task tree`
- 文件位置：`test/db.test.mjs`
- 现象：Windows 清理期 `rmSync` 抛 **EPERM**
- 性质：**本任务开工前就存在**（历史记录里从 T1 起就在），与 D17 无关；门禁按用例名放行，
  **本任务不删断言、不跳过、不制造失败去满足名单**。

> 历史任务口径写的是"957 条 / 956 通过 / 1 失败"。实测起点比它**多 27 条**（批次2 后续提交新增的用例）。
> 出口判据是"**最终通过数不低于实测通过数（983）**"，不是"不低于 956"。

## 5. 浏览器验收链起点

- 白名单：`scripts/verify/suites.json` 里 **10 套 active + required**（`scripts/check-verify-scripts.mjs` 可复核）。
- 直接覆盖被拆区域的三套：`day-panel` / `daily-effort` / `workspace-picker`。
- **知识域没有专属浏览器套件**（现役 10 套里没有 `knowledge` 场景）⇒ P1 的行为覆盖靠
  源码级接线判据 + 后续 B 层补充场景；这一点在 `verification.md` 里按"未验证层"如实记录。

## 6. 变异探针起点

- `scripts/release-preflight.mjs` 的 pre 阶段**当前并非全绿**：`KNOWN_PROBE_DEBT` 里仍登记
  `model` B7/B8/B10 与 `quick-workspace` M6/M14 的**失效锚点**，`judgeProbes` 对 stale/unreliable **无条件硬红**。
- 与 D17 相关的口径（设计 §10.3）：**D17 迁移影响的探针重锚是必做**；
  与 D17 无关、且开工实测仍能正常运行的历史真盲点才按非阻塞欠账登记；
  model/quick 的失效重锚安排**独立测试基建提交**，不得混进业务重构提交。

## 7. 本次施工起点与设计文档"调研快照"的一致性核对

设计文档 §1 的"本次源码调研快照"写的是：入口 5725 / 本体 4197（276–4472）/ 直接 state 114 / package 1.16.2。
**逐项复核一致**（见上表），所以设计文档可以原样作为施工图使用，不需要重写。

唯一需要补的是"单测"那一行当时写"本轮未运行" —— 现已实测为 984/983/1，**已回填进设计文档 §1 表格**。
