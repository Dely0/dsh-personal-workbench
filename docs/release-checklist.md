# 发布检查清单（release checklist）

> 每次发布**按顺序**走一遍。任何一步失败就停下，不要"先发了再说"。
>
> 为什么要有这份清单：**v1.13.0 因为"发布早于验证"翻过一次车** —— npm 上已经是最新版，
> 本机还没验证，用户升级后前端直接 `Failed to load plugins`。
> 结论固化成本清单第 3 步：**先本机验证，再发布**。

---

## 0. 前置：确认要发的是哪个版本

- [ ] `package.json` 的 `version` 已是目标版本（发布后再改版本号等于发了两个版本）。
- [ ] 本轮所有子任务都已合入工作区，且没有半成品（`git status` 里没有意外文件）。
- [ ] 数据库 schema **只单向前进**：需要变更时写**新**迁移、不改旧迁移
      （旧库要能升上来；已经升上来的库不会因为插件回退而能用 —— 所以回退插件前一定要看第 4 步）。

## 1. 静态检查与测试（必须全绿）

```sh
pnpm typecheck          # tsc --noEmit，退出码 0
pnpm test               # 构建 + node --test test/*.test.mjs，0 fail
```

- [ ] `pnpm typecheck` 退出码 0。
- [ ] `pnpm test` 输出 `fail 0`，且**测试条数不少于上一个发布**（少了说明有用例被删/被跳过，
      要么补回来，要么在 Release Notes 里说明原因）。
- [ ] 版本级验收要求：Release Notes 里**逐条对应**本版本的子任务。

## 2. 本机安装验证（**先本机，后发布**）

```sh
# 日常迭代：构建 → 打包到"带构建戳"的开发包 → 装盘 → 跑门禁
node scripts/dev-install.mjs            # 默认 dry-run：只构建+打包+校验，打印将执行的命令
node scripts/dev-install.mjs --apply    # 真装：自动备份 + 零增量 diff + BOM 复检 + 三道门禁
```

- [ ] **本地迭代不动 `package.json` 的 `version`**。profile 依赖的身份是 tarball **路径**，
      所以每次打包落到新路径（`_local-build/…-dev-<短hash>-<时间戳>.tgz`）就必然重新解包；
      公开版本号只在**发布**时增长（下一个发布版本：**1.15.0**）。
- [ ] ⚠️ **绝不能用 `pnpm install` 代替 `dsh plugin add`**。实测口径（pnpm 11.7.0，
      与 profile 同配置的 `node-linker=hoisted`，2026-09-15）：覆盖同名同版本的 tarball 之后，
      `pnpm install` 与 `pnpm install --frozen-lockfile` **都不会刷新**装盘产物；
      而 `dsh plugin add file:…`（= `pnpm add`，DSH 只是 pnpm 的原样转发器）**会**。
      老结论「换了构建产物就必须换版本号」把两件事归成了一件：这条 `install` 的坑，
      加上**客户端 bundle 的 rev 缓存**（宿主启动时才建 Map —— 不重启就是在验旧代码）。
      它让 patch 号一路吃到 14.59（`_local-archive/` 里 84 个 tgz = 84 次本地迭代）。
- [ ] **改 profile 之前先备份** `package.json` 与 `pnpm-lock.yaml`
      （脚本用 `<file>.bak-devinstall-<yyyyMMdd-HHmmss>`，命名惯例不变）。
- [ ] 装完与备份逐行 diff：**只有目标插件那一处变化**，其余插件零改动、锁文件无额外条目增删。
- [ ] 写盘后复检 **BOM**：`package.json` 头 3 字节不得是 `EF BB BF`
      （带 BOM 时 Node 的 `JSON.parse` 直接抛错 → DSH 进程起不来、GUI 也进不去）。脚本已内建这一步。
- [ ] `node scripts/check-installed-fingerprint.mjs` 退出码 0
      （**逐文件 SHA256** 比对开发树 `lib/` 与 profile `node_modules`，并核对版本号）。
      这是"装盘产物 == 当前构建"的唯一可信判据 —— **版本号从来不是**。
- [ ] `node scripts/check-installed-version.mjs` 退出码 0
      （比对装盘版本 / profile 声明 / 锁文件 / 数据库 schema / 插件支持 schema）。
      注意它只看**版本号声明**，管不住"同版本号内容不同"，所以上面那条指纹校验不能省。
- [ ] `dsh --profile web --dump-config` 退出码 0、无 `pending`（插件树能组装）。

> 需要**在浏览器里自动验一遍**（不用人点）时，仓库里有零依赖的 CDP 脚本
> （Node 24 自带 WebSocket，不需要 browser-use / Playwright）：
>
> ```sh
> node .pwtest/verify-ui.mjs "http://127.0.0.1:3080/?token=<token>"      # 入口/面板/单一实例
> node .pwtest/verify-draft.mjs "http://127.0.0.1:3080/?token=<token>"   # 草稿弹框行为
> ```
>
> 它们会另开一个独立调试实例（独立 profile + 端口），**不影响你正在用的浏览器窗口**。
> token 在 `dsh web` 的启动日志里（`[dsh web: http://127.0.0.1:3080/?token=...]`）。

## 3. 重启与本机实操验证

```sh
# 重启 dsh web（会中断当前 GUI 会话 —— 必须拿到用户明确指令再重启）
```

- [ ] **重启前拿到用户明确指令**。步骤 2 只改了文件，不重启不会生效，但也不能擅自重启。
- [ ] 重启后 `/api/workbench/health` 返回的版本 = 目标版本，`schema` 与插件支持值一致。
- [ ] 浏览器硬刷新（客户端 bundle 有缓存）。
- [ ] 按 Release Notes 的"验收方式"逐条走一遍**本次改动涉及的**用户可见路径
      （每个版本至少要覆盖：入口能打开、面板能关掉、任务能建、AI 会话能起）。
- [ ] 看一次 `dsh web` 的控制台：不应出现 `[workbench]` 开头的 `console.warn`
      （`official slot registration failed` / `layout.selectPanel failed` 都说明降级了，
      要么是本机宿主版本本来就旧、要么是真的坏了 —— 必须判断清楚是哪种）。

## 4. 降级与回滚预案（写下来，别现场想）

- [ ] 记录**当前可用组合**：插件版本 + DSH 版本 + 数据库 schema。
- [ ] 明确回滚到上一个版本时数据库是否兼容：
      **如果 schema 已经前进，回滚插件会导致宿主拒绝启动** —— 这种情况只能"往前修"，不能回退。
- [ ] 确认 `node scripts/check-installed-version.mjs` 能在**不重启**的情况下发现问题。

## 5. 发布

- [ ] `git tag v<version>` + 提交信息里写清"本版本子任务清单"。
- [ ] 发布 Release Notes，包含：新增/修复/破坏性变更/已知问题/**验收方式**。
- [ ] 若目标是 npm：`pnpm publish`（`files` 白名单已含 `lib`、`cordis.patch.yml`、`README.md`、
      `LICENSE`、`THIRD_PARTY_NOTICES.md`、`screenshot`；**确认 `lib/` 是最新构建产物**）。
- [ ] 发布后再跑一次 `node scripts/check-installed-version.mjs`（防止发布动作本身改了 profile）。

## 6. 发布后

- [ ] 把本版本的**经验教训**沉淀：`docs/issues/` 或 `workbench_submit_knowledge`（知识草稿）。
- [ ] 相关 issue 关闭并打标签，评论里链接对应 Release。
