# 旧四套回归判据源（版本化文档快照）

2026-09-30 只读提取，**未执行这些脚本**。来源为本机`.pwtest/verify-acceptance.mjs`、`verify-final-2.mjs`、`verify-sidebar-collapse.mjs`、`verify-duplicate-task.mjs`的实际check调用。旧脚本可能含机器路径/认证参数，不直接复制到文档或公开仓库；迁移时读本地源码、去硬编码并脱敏。

本文件是S17的版本化判据输入。即使新机器没有gitignored `.pwtest`，也能依据此文档实现对应回归；但不能宣称是逐字迁移旧脚本。若需要逐字迁移且原脚本不可获得，明确阻塞该迁移片段，请用户提供源码。不得只凭17/9/6/11或套件名字发明断言。

## 0. 共用观测定义

- UI入口：侧栏中可见button，aria-label含“工作台”或旧`data-dsh-personal-workbench-entry`标记；计可见行数，不能只查textContent精确相等。找不到入口/返回按钮是失败，不跳过。
- 面板：工作台自建`.wb-panel-host`；读取data-open、getBoundingClientRect、computed display/visibility。打开断言data-open='1'且宽度>300（duplicate-task旧判据>200）；收起data-open!='1'且不可见（acceptance）。不靠截图单独证明。
- 点击：CDP真实Input鼠标事件定位可见节点的中心；截图与重读真实DOM。等待改为有上限的状态轮询，不把旧sleep数值当产品要求。
- 整屏blocker：body元素position=fixed/absolute、pointerEvents!='none'、display!='none'、opacity!=0，宽/高至少视口80%；排除工作台自身面板层。中心观测点约(W*0.6,H*0.5)，顶层元素class不应以wb-开头（收起态），打开态应是工作台层。
- 皮肤快照：html上的data-dsh-wallpaper-active/data-dsh-backdrop-active存在集合；开合前后相等，插件不擅改。
- 控制台：slot entry crashed计0；未捕获pageErrors计0。历史脚本排除`[network]`错误；迁移后只排明确无关的网络噪声，并在summary单列，不排验收API/认证/脚本加载失败。
- 原脚本中的旧行号只定位本次提取来源，未来以本文件ID为长期判据。每项都必须执行，不因按钮没找到或前步骤缺失减少计数后报通过。
- 兄弟DOM标记的注入仅为**隔离测试页面fixture**，不是授权插件实现读取/改写兄弟标记。fixture必须finally撤销，不影响用户正在使用的页面；生产代码继续受I5扫描。

## 1. acceptance：17项

实际来源check调用位于旧verify-acceptance.mjs约96–241行。

| ID | 前置/动作 | 必须观察到 |
|---|---|---|
| LEG-A01 | 初始侧栏 | 可见工作台入口恰好1行 |
| LEG-A02 | 初始页面 | 非本插件整屏blocker=0 |
| LEG-A03 | 点击可见入口 | data-open=1，hostShown=true，面板宽>300 |
| LEG-A04 | 打开态中心观测点 | 工作台面板在最上层 |
| LEG-A05 | 打开态 | 非本插件整屏blocker=0 |
| LEG-A06 | 隔离fixture写data-dsh-taskboard-active | 工作台仍打开且可见（不承担旧跨插件DOM互斥） |
| LEG-A07 | 同上 | 兄弟标记仍在，没有被本插件删除 |
| LEG-A08 | 撤销fixture标记 | 工作台仍打开可见，无幽灵变化 |
| LEG-A09 | 再次点击官方入口 | 工作台能处于打开可见状态（旧标题“收起后再点”与脚本动作不完全一致，迁移需显式记录实际序列；真正收起/重开另由A10及final-2覆盖，不以标题虚报步骤） |
| LEG-A10 | 点击返回对话 | data-open不再为1且hostShown=false |
| LEG-A11 | 收起态中心观测点 | 不再是工作台层 |
| LEG-A12 | 收起态 | 非本插件整屏blocker=0 |
| LEG-A13 | 收起态侧栏 | 工作台入口仍恰好1行 |
| LEG-A14 | 全序列控制台 | slot crash=0且未捕获异常=0 |
| LEG-A15 | 每一个采集状态 | 非本插件整屏blocker全部为0，不只比较首尾 |
| LEG-A16 | 初始与收起态 | wallpaper/backdrop皮肤属性集合相同 |
| LEG-A17 | 初始与兄弟fixture撤销后 | 皮肤属性集合相同 |

## 2. final-2：9项

实际来源旧verify-final-2.mjs约76–102行；该套定位为开/关最小闭环，与acceptance重叠但不替代。

| ID | 前置/动作 | 必须观察到 |
|---|---|---|
| LEG-F01 | 初始侧栏 | 可点工作台入口恰好1 |
| LEG-F02 | 初始页面 | 非工作台blocker=0 |
| LEG-F03 | 初始中心 | 不是wb-工作台层 |
| LEG-F04 | 点击入口 | data-open=1且面板宽>300 |
| LEG-F05 | 点击返回对话 | data-open不再为1 |
| LEG-F06 | 收起后 | 非工作台blocker=0且中心不是wb-层 |
| LEG-F07 | 收起侧栏 | 工作台入口仍恰好1 |
| LEG-F08 | 全序列 | 无槽位崩溃、无未捕获异常 |
| LEG-F09 | 开合前后 | 皮肤属性集合相同 |

## 3. sidebar-collapse：6项

实际来源旧verify-sidebar-collapse.mjs约143–158行。核心不是外观，是主线程仍响应。

| ID | 前置/动作 | 必须观察到 |
|---|---|---|
| LEG-S01 | 收起侧栏 | 测试页心跳after>before，两次读取均在6s内返回 |
| LEG-S02 | 再次展开 | 心跳递增，页面未卡死 |
| LEG-S03 | 打开工作台面板 | 心跳递增，页面未卡死 |
| LEG-S04 | 面板开着时收起侧栏 | 心跳递增，页面未卡死 |
| LEG-S05 | 全序列 | ResizeObserver loop/Maximum update depth/Too many re-renders告警=0 |
| LEG-S06 | 全序列 | 未捕获异常=0 |

旧实现对找不到后续按钮的情况有条件跳过check；迁移必须改为明确前置失败，不允许少测却报6/6。心跳变量只能在独立测试浏览器页面设置，结束后清理。

## 4. duplicate-task：11项

实际来源旧verify-duplicate-task.mjs约64–159行，**会创建草稿、任务和归档**；只有显式独立测试DB可跑。合成title带runId，task type=personal/priority=p3，清理只处理此次taskId/draftId，不按其他用户同名标题批量归档。

| ID | 前置/动作 | 必须观察到 |
|---|---|---|
| LEG-D01 | health | version等于目标包版本；新链另比buildId，不让同版本旧包通过 |
| LEG-D02 | 提交并确认第一份同名task草稿 | HTTP200且返回task.id |
| LEG-D03 | 再提交第二份同名草稿但未确认 | 该runId标题未归档任务仍1条、另有pending草稿 |
| LEG-D04 | 打开工作台 | 面板存在，data-open=1且宽>200 |
| LEG-D05 | 点第二份“确认入册” | 出现“库里已经有一条同名任务”选择框 |
| LEG-D06 | 真鼠标点“就用已有那条” | 该runId未归档任务只剩1 |
| LEG-D07 | 同上 | 重复新建那条已归档且数据保留，不硬删 |
| LEG-D08 | 再确认同一份第二草稿 | HTTP200且replayed=true |
| LEG-D09 | 同上 | 未归档任务数量不变 |
| LEG-D10 | 全序列 | 无slot crash/Uncaught/TypeError/ReferenceError相关异常 |
| LEG-D11 | finally清理此次生成资产 | 未归档runId任务=0、pending草稿结束；失败不能吞掉原失败 |

## 5. 迁移与差异记录

S17先读这些ID并核对本机源脚本，迁入scripts/verify/suites/时保留判据语义、去机器路径与认证参数。因新安全要求必须修的脚手架问题（条件少测、旧版本号误认新构建、错误退出/清理误伤）记在迁移摘要；这些不算降低产品判据。

本文件43项是**源码断言快照**，不是本轮43项测试通过。缺旧源码但有本文时可以明确标为“依据版本化判据重建”，不能声称逐字迁移；有任何无法还原的额外场景必须指出编号并阻塞对应套件，不写自造通过数。后续新功能AX矩阵仍独立必需，不由这43项替代。
