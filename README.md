# dsh-personal-workbench

A personal workbench plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web.
Turn your DSH into a **calendar + task list + AI assistant workbench**.

[English](#english) · 简体中文

---

# 中文

## 这是什么

`dsh-personal-workbench` 是一个 **DSH 个人工作台插件**：

- 📅 日历（周/月可切换）+ 任务列表（树状层级）
- ✨ 自然语言快速录入，AI 澄清后自动生成任务
- 🧠 每个任务可关联多个 AI 会话：澄清 / 咨询 / 拆解 / 执行 / 复盘
- ✅ 任务执行采用“AI 申请完成 → 用户验收”闭环
- 🗂️ 每个任务一个 AI 会话工作区（默认工作区 + 任务名文件夹）
- 📝 Markdown 任务描述、复盘记录、变更历史
- ⏰ 到期提醒（页内横幅）
- 🗄️ 归档区、任务恢复

数据完全存储在本地 `~/.dsh/workbench`，不上传任何服务器。

## 截图

| 主界面 | 日历 | 任务列表 |
|---|---|---|
| ![主界面](screenshot/%E4%B8%BB%E7%95%8C%E9%9D%A2.PNG) | ![日历](screenshot/%E6%97%A5%E5%8E%86%E9%A1%B5%E9%9D%A2.png) | ![任务列表](screenshot/%E4%BB%BB%E5%8A%A1%E5%88%97%E8%A1%A8%E7%95%8C%E9%9D%A2.png) |

| 知识库 | 点子 | 点子王 |
|---|---|---|
| ![知识库](screenshot/%E7%9F%A5%E8%AF%86%E5%BA%93%E7%95%8C%E9%9D%A2.png) | ![点子](screenshot/%E7%82%B9%E5%AD%90%E7%95%8C%E9%9D%A2.png) | ![点子王](screenshot/%E7%82%B9%E5%AD%90%E7%8E%8B.png) |

## 功能清单

### 任务
- 任务字段：标题、Markdown 描述、类型、状态、优先级、截止时间、AI 策略、提醒、工作区
- 无限层级子任务；今日 / 日历 / 列表三种视图
- 任务类型、状态、优先级全部由字典表驱动，可自行扩展（编辑数据库或后续 UI）
- 已完成 / 已取消任务不可再次执行

### AI
- **快速录入澄清**：一句话 → 官方会话区进行需求澄清 → 生成待确认草稿
- **AI 咨询**：对任务提问、要建议（不执行）
- **AI 拆解**：生成子任务提案树，确认后落库
- **AI 执行**：仅叶子任务且 AI 策略为“可执行”时可执行；AI 完成后提交验收申请，用户验收后才算完成
- **AI 智能排序（任意日期）**：今日/日历任一日期一键生成执行顺序提案，确认后应用（不修改任务字段）
- **AI 日报/周报**：基于任务事件与完成记录自动生成报告草稿，确认后保存并可回看、删除
- **系统级桌面提醒**：任务到期时在浏览器已授权的情况下发送系统通知（页面可最小化）
- **重复任务**：任务可设置每天/每周/每月重复，到期自动生成实例（模板归档即停止）
- **个人知识库 / 错题集**：经验教训、决策、笔记、片段沉淀为可搜索知识条目，复盘一键沉淀，AI 可提交知识草稿
- **点子 / 点子王**：灵感卡片快速记录；AI 自动找关联生成“点子王”；AI 头脑风暴后可确认转为任务
- **AI 复盘**：已完成任务一键复盘，结论确认后写回任务
- 同一任务只保留一个复盘会话；重复复盘进入同一会话

### 数据与安全
- SQLite（`~/.dsh/workbench/workbench.db`）+ 每日 JSON 备份规划
- 所有工作台 API 均挂载在 `/api/workbench/*` 且仅允许 loopback 访问
- 不读取、不上传 DSH 之外的任何数据

## 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **0.1.0-rc.6** Web 版
- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `>=11.7.0 <12`
- 网络可访问 npm registry（或使用镜像）

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add git+https://github.com/Dely0/dsh-personal-workbench.git
```

或安装 Release tarball：

```sh
dsh plugin --profile web add file:/path/to/dsh-personal-workbench-<version>.tgz
```

安装后重启 `dsh web`，浏览器硬刷新（Ctrl+Shift+R）。

### 从源码开发

```sh
git clone https://github.com/Dely0/dsh-personal-workbench.git
cd dsh-personal-workbench
pnpm install
pnpm check      # 类型检查 + 构建
pnpm test       # 最小回归测试（使用构建产物）
```

以开发模式挂载：

```sh
pnpm build
dsh plugin --profile web add link:/path/to/dsh-personal-workbench
```

> 开发模式修改代码后需要重新 `pnpm build` 并重启 `dsh web`。

## 兼容性与已知限制

- 当前版本针对 **DSH 0.1.0-rc.6 Web 版** 开发与测试。
- 客户端侧边栏入口和中心列接管依赖 rc.6 的 DOM 结构契约（`data-pane`、`logoRow`、`centerCol` 等 class）。
  **DSH 升级到新的大版本时，必须重新验证这些选择器，必要时适配。**
- 与 `dsh-web-ui`（task-board / ssh）共存时使用其 `data-dsh-*` 互斥协议；未安装时自动失效，**不依赖 dsh-web-ui**。
- 仅支持单用户本地使用；无云同步、无多用户权限体系。
- AI 能力依赖你在 DSH 中已配置的模型与凭证；执行/咨询等会真实消耗 token。

## 路线图

- [x] V1：任务 / 日历 / 快速录入澄清 / 子任务 / 会话关联
- [x] V1.5：AI 执行 + 用户验收 / 复盘 / 归档 / 变更历史 / 任务工作区
- [x] V2 每日 AI 智能排序（0.6.0）
- [x] V2：系统级桌面提醒（0.8.0）
- [x] V2 日报/周报（0.7.0）
- [x] V2：重复任务（0.12.0）
- [x] V2：个人知识库 / 错题集（1.0.0）
- [ ] V2：定时自动化
- [ ] 未来：多端同步、任务拖拽排序、数据导入导出

## 免责声明

本插件为社区项目，与 DeepSeek 官方无关，不提供任何担保。安装即表示你信任该代码会以你的 DSH 用户权限在本机运行。执行类 AI 操作可能修改工作区文件、消耗 API 额度，请先阅读代码并谨慎使用。

## License

本项目代码使用 [MIT License](./LICENSE)。

部分 DOM 挂载模式和客户端构建包装参考了以下开源项目，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)：
- `dsh-task-board`（dsh-web-ui，BSD-3-Clause）
- `dsh-genui`（MIT）

---

# English

## What is this

`dsh-personal-workbench` is a personal workbench plugin for DeepSeek Harness Web:
calendar + hierarchical task list, natural-language task intake with AI clarification,
multiple AI sessions per task (clarify / consult / break down / execute / review),
execution with user acceptance, AI prioritization for any date, daily/weekly reports,
desktop notifications, per-task AI workspaces, reminders, archives, and Markdown reviews.

All task data is stored locally under `~/.dsh/workbench`.

## Install

```sh
# From source or release tarball
dsh plugin --profile web add git+https://github.com/Dely0/dsh-personal-workbench.git
dsh plugin --profile web add file:/path/to/dsh-personal-workbench-<version>.tgz
```

Then restart `dsh web` and hard-refresh the browser.

## Compatibility

- Built and tested against **DeepSeek Harness 0.1.0-rc.6 Web**.
- Does **not** depend on `dsh-web-ui`; optional coexistence protocol only.
- Node.js `^22.19.0 || >=24.0.0`, pnpm `>=11.7.0 <12`.

## Roadmap

- [x] V2: AI prioritization for any date, OS-level notifications, daily/weekly reports
- [x] V2: recurring tasks, personal knowledge base / lessons, ideas & idea clusters
- [ ] Future: scheduled automation, multi-device sync, drag-and-drop, import/export

## License

MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
