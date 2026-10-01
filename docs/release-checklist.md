# 发布检查清单（release checklist）

> 每次发布**按顺序**走一遍。任何一步失败就停下，不要"先发了再说"。
>
> 为什么要有这份清单：**v1.13.0 因为"发布早于验证"翻过一次车** —— npm 上已经是最新版，
> 本机还没验证，用户升级后前端直接 `Failed to load plugins`。
> 结论固化成本清单第 3 步：**先本机验证，再发布**。

---

## 0. 前置：确认要发的是哪个版本

- [ ] ⚠️ **用户已实测确认**（v1.13.0 的复盘把它列为发布前置项，见团队记忆
      `01M2A08YG35QQ3KXEJY5C7BZRH`）：顺序是「本机 dev 装盘 / 热重载 → **用户实测确认** →
      才 publish / Release / 打 tag」。npm 与 GitHub Release **都不可撤销**，而 UI 类改动
      最需要肉眼确认 —— DSH Web 有 activation token 鉴权（`/` 与 `/plugins/*` 返回 401），
      **agent 侧无法免登录打开 GUI**，所以"我这边跑通了"不等于"用户那边对了"。
- [ ] ⚠️ **一个版本一个主题**（同一复盘）：范围蔓延是本项目最大的返工源。
      确实漂进来的事要么**单独挂 sibling 任务**，要么在 Release Notes 的"其它修复"里显式列出并说明为何同版。
- [ ] `package.json` 的 `version` 已是目标版本（发布后再改版本号等于发了两个版本）。
- [ ] 本轮所有子任务都已合入工作区，且没有半成品（`git status` 里没有意外文件）。
- [ ] 数据库 schema **只单向前进**：需要变更时写**新**迁移、不改旧迁移
      （旧库要能升上来；已经升上来的库不会因为插件回退而能用 —— 所以回退插件前一定要看第 4 步）。

> **本节是自足的**：上面第 0 步那两条前置（用户已实测确认 / 一个版本一个主题）与下面各节合起来就是完整门禁，
> 不需要引用别处的文档或工具。**不要**在这里写任何本机专有的路径、凭据位置或代理地址 ——
> 这是公开仓库，写了等于把本机布局发出去（本机确实另有一份只对本机成立的发布清单，它不在这里、也不该出现在这里）。

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
      公开版本号只在**发布**时增长（下一个发布版本：**1.15.9**）。
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

- [ ] ⚠️ **只改文档/配置/测试等"非编译内容"时，不要单独发版** ——
      把改动留在工作区，**跟随下一个有代码改动的版本一起发布**。
      理由：npm 的版本号是给用户消费的，为一句致谢或一段说明单独占一个版本号没有意义；
      而且 `lib/` 产物不变时发版对用户是零收益。
      （2026-09-17 因为 README 漏了致谢而单独发了 `v1.15.4`，属于判断失误；
      用户明确要求：**非编译内容跟随后面的版本一起更新发布**。）
- [ ] `git tag v<version>` + 提交信息里写清"本版本子任务清单"。
- [ ] 发布 Release Notes，包含：新增/修复/破坏性变更/已知问题/**验收方式**。
      本版若夹带了此前积累的文档修正，在 Release Notes 里**一并说明**（别让它静默搭车）。
- [ ] ⚠️ **GitHub Release 的 Title 只写版本号**（`v1.15.4`），**不要**加破折号与描述。
      内容全部放 body。用户 2026-09-17 明确要求过这条（v1.15.2 / v1.15.3 当时带了描述，
      已发布的没改；从 v1.15.4 起按此执行）。
      `name` 就是标题，别顺手把"主题"写进去 —— `## 主题` 那一段属于 body。
- [ ] **`git tag` + `push` ≠ 建了 Release**：`/releases` 页面显示的是 **Release 条目**，
      只能由网页「Draft a new release」或 `POST /repos/{o}/{r}/releases` 创建；
      只推 tag 时那一页会停在上一版（v1.15.2 就这么漏过一次）。
      验收判据是 `GET /releases/latest` 指向新版本。
- [ ] ⚠️ **发版前确认 README / 致谢 / THIRD_PARTY_NOTICES 都写完了**。
      它们是**编译产物之外**的东西，而 npm 页面渲染的是**包内 `README.md`**，
      npm 又不允许覆盖已发布版本 —— 一旦发布后才发现漏了，npm 上就只剩两条路：
      发一个多余的 patch 版本（**不推荐**，见本节第一条），或者**等到下一个版本才送达**。
      所以正确做法是**在发版前把文档核对干净**，而不是事后补发版本。
- [ ] ⚠️ **发版前跑 PII 扫描：`node scripts/check-pii.mjs`（退出码 0）**。
      它分**两个面**扫：面一 = git 跟踪文件（GitHub 公开面）；面二 = `lib/**`（**会随 npm 包发布**，
      源码里一句 JSDoc 注释也会被用户看到）。v1.16.0 发布前正是靠它抓出 3 处会随包外发的泄漏。
      **命中不等于要删**：逐条判断是"给用户看的示例文案（合法）"还是真泄漏 —— 误报一键删会删掉产品文案。
- [ ] 若目标是 npm：`pnpm publish`（`files` 白名单已含 `lib`、`assets/personas`、`cordis.patch.yml`、
      `README.md`、`LICENSE`、`LICENSE-novotnyllc-dotnet-artisan`、`LICENSE-K-Dense-scientific-agents`、
      `THIRD_PARTY_NOTICES.md`、`screenshot`；**确认 `lib/` 是最新构建产物**）。
      ⚠️ 两份上游 `LICENSE-*` 是 **MIT 的硬要求**（"副本中保留版权声明与许可全文"）——
      随包内置了第三方 persona 就必须带上，漏了等于署名义务破。
- [ ] 发布后再跑一次 `node scripts/check-installed-version.mjs`（防止发布动作本身改了 profile）。
- [ ] 发布后**拉回真实产物复核**：`npm pack <pkg>@<ver>` 解包，确认包内 README 是最新的、
      不含 `docs/` `test/` `scripts/`、**无私人信息**（对解包目录再跑一次 `node scripts/check-pii.mjs dist`）。

## 6. 发布后

- [ ] 把本版本的**经验教训**沉淀：`docs/issues/` 或 `workbench_submit_knowledge`（知识草稿）。
- [ ] 相关 issue 关闭并打标签，评论里链接对应 Release。
- [ ] **外部贡献的致谢在合入时就写上，不要留到发版**（v1.15.3 漏过一次）：
      `README.md` 的致谢段（中英双段）补上贡献者与具体贡献，
      `THIRD_PARTY_NOTICES.md` 登记可追溯信息（报告/PR 链接、许可证、逐项说明）。
      源头解决就不会出现"发布后才发现致谢漏了"这种被动局面。
- [ ] 在 `docs/releases/v<ver>.md` 写下**发布产物表**（版本号 / tag / npm / Release URL / 提交 / **包哈希** / 文件数），
      并附上"拉回真实产物复核"的结论 —— 这一节是"四者一致"的书面证据。

## 7. 判"发布成功"的判据（v1.16.1 的血泪版）

**先跑一键门禁**（2026-10-02 起）：机械判据全部由脚本执行，不再靠人逐条记得 ——

```powershell
node scripts/release-preflight.mjs                                   # 发版前
node scripts/release-preflight.mjs --phase post --version <version>  # 发布后
```

它覆盖：typecheck → 全量单测 → **全部变异探针（每步自动 `pnpm build`）** → PII 两面 → 版本号与文档就位；
发布后覆盖：`dist-tags` → **tarball 200 + sha1 与 `dist.shasum` 对账** → 用户视角安装 →
GitHub `releases/latest`。欠账（历史失败 / 已知盲点 / 良性 PII）**显式登记在脚本里**，
名单外的红会 exit 1；**名单里已经不红的也会 exit 1**（还清了必须删名单）。

下面是它执行的判据本身（也是手工复核时的顺序）：

**退出码 0 不算、网页显示 "Published" 也不算。** 按这个顺序查：

1. `GET https://registry.npmjs.org/-/package/<pkg>/dist-tags` → `latest` 指向新版本；
2. `curl -sSL -o x.tgz https://registry.npmjs.org/<pkg>/-/<name>-<ver>.tgz` → **HTTP 200**（404 就是还没成）；
   再 `Get-FileHash x.tgz -Algorithm SHA1`，与 `GET /<pkg>/<ver>` 的 `dist.shasum` **逐字节比对**；
3. **用户视角**：空目录 + `--cache <全新目录>` 跑一次 `npm i <pkg>`（不指定版本，走 `latest`）必须成功。

> 反面教材（2026-10-01 发 v1.16.1）：`npm publish` 在传输途中被掐断，服务端留下
> "版本元数据已写、tarball 未落、packument/dist-tag 未提交"的中间态 ——
> 此时 `GET /<pkg>/<ver>` 返回 **200**（极易误判成"发出去了"），而 tarball **404**；
> **npm 网页对维护者还会把这条记录显示成 "Published" 并列出 `<ver> = latest`**。
> 其后重发一律 `409 Cannot publish over previously staged version`（措辞会变，别按字面理解），
> 而 `npm stage list` **同时是空的**（没有 stage-id 可批准）。
> 真正解掉它的是：**在正确目录用会话身份（`npm login`）重发一次**，让提交完成。

**两条配套硬规矩**（这次都踩了）：

- **发布命令单独一条执行**，绝不与 `git push`（带 `HTTPS_PROXY`）写在同一条命令里 ——
  同进程的环境变量会被包管理器继承，registry 请求走错代理而超时/被掐断。
  发布前显式清：`Remove-Item Env:\HTTPS_PROXY,Env:\HTTP_PROXY,Env:\ALL_PROXY`。
- **`npm view <pkg>@<ver>` / `npm i` 都可能命中本地 npm 缓存**（表现为 `E404` / `notarget`），
  而**同一时刻直连原站的 HTTP 读取可能已经是最新的**。两边不一致时用 `curl` 直连原站裁决，别急着下结论。

> 另注：npm 正在废除 **bypass-2FA granular token 的直接发布**（账户类操作 2026-08 已生效、
> 直接发布预计 2027-01 取消），发布时会打 deprecation notice。长远要迁到
> [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) 或
> [staged publishing](https://docs.npmjs.com/staged-publishing)（token 只 stage、人 2FA 批准）。
