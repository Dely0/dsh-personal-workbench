---
name: dsh-release
description: DSH 插件（@dely0/dsh-personal-workbench / dsh-team-memory / dsh-skill-hub 等）**公开发布**的硬门禁与命令序列：发布前置（用户实测确认）、范围表、改版本号、同步 README 版本历史与致谢、写 Release Notes、发版前检查（PII 两面 + 变异探针）、打 tag、pnpm publish 到 npm、用 REST 建 **GitHub Release**、发布后复核（**tarball 与 shasum 对账**）。当你要「发版 / 发布 / 打 tag / 发 npm / 建 Release / 写 Release Notes / 升版本号 / 检查有没有私人信息」时使用。只管发布链条；**装盘进 profile 与重启**（本机生效）归 dsh-safe-plugin-ops，两者一前一后。
whenToUse: 本轮要动 public 版本号、要给仓库打 tag、要 `npm publish`、要在 GitHub 上建 Release 或写 Release Notes 时。
---

# DSH 插件公开发布（硬门禁）

> 版本：**V1.4.0（2026-10-05）**。V1.0.0 的条目全部来自真实发布里**实际犯过的错**（一次发了
> 1.15.2 / 1.15.3 / 1.15.4 三个版本）；V1.1.0 并入团队记忆里的发布教训；V1.2.0 并入 v1.16.1 这一版
> 的真实翻车；V1.3.0 把门禁从"文档里的步骤"变成"一条可执行的命令"；
> **V1.4.0 用 v1.16.5 的实测把「npm 只 stage、不发布」写死成判据**（见下）。
>
> **V1.4.0 改了什么、为什么**（全部来自 2026-10-05 发 v1.16.5 的真实发布）：
>
> | 改动 | 触发它的真实事故 |
> |---|---|
> | §5/§7 明确：**发布这一步只能走"会话身份 + 交互式 2FA"**，bypass-2FA 令牌只用做只读核对 | `pnpm publish`（令牌）退出码 0、还打印 `✅ Published package`，registry 上却版本 404、tarball 404、`latest` 纹丝不动 |
> | §7 的骗人信号表补上 **`✅ Published package`** 这句输出 | 同上；而且这次是 **`pnpm`** 打的（不只是 `npm`） |
> | §7 的"中间态"补第二种形状（版本端点也可能 **404**）与 **409 的真实文案** | 重发拿到 `409 Cannot publish over previously staged version "1.16.5"`；而 `GET /<pkg>/1.16.5` 自始至终是 404 |
> | §7 新增**"成功伪装成失败"**的字符串 `You cannot publish over the previously published versions: <ver>` | v1.16.5 落地时那次交互式 `npm publish` 报的就是它，差点被记成发布失败 |
> | §7 明确**哈希口径**：要比的是 **registry 下回来的那份 tarball** | 本地 `8c3c10f7…` vs registry `130d4e7b…`，看着像事故；实为包内 `package.json` 少了 `packageManager`/`prepare`（历年发布形态），代码文件 SHA256 与 `buildId` 完全一致 |
> | §11 更正 `npm stage list` 的表现：不止 `E401`，也可能是 **200 但空** | 会话身份与 bypass 令牌**都查到空列表** ⇒ 没有 stage-id ⇒ "去 approve 一下"这条退路不存在 |
>
> **V1.3.0 改了什么、为什么**：
>
> | 改动 | 触发它的真实事故 |
> |---|---|
> | §3/§7 的机械门禁改为**一条命令** `node scripts/release-preflight.mjs`（`--phase pre\|post`） | 门禁只写在文档里 ⇒ 靠人记得 ⇒ 发 v1.16.1 时**整条探针门禁被漏跑**。现在漏跑 = 直接没有那张绿灯 |
> | 欠账处理统一为**显式名单 + 双向断言**（名单外的红阻塞；名单里已不红的也阻塞） | 防止"反正都列着"的橡皮图章；本次实测：preflight 第一次跑就把 capacity 探针失效判成**阻塞项** |
> | 探针汇总**两种约定都认**，认不出按**不通过** | 第一次跑时 `probe-listview-mutations` 用的是 `变异探针：17/17 条变异都变红`，我的解析器只认 `✅ N/N 条变异都被断言抓到` ⇒ 把**绿的判成了红**；反过来也可能是把红的判成绿 |
>
> **V1.2.0 改了什么、为什么**：
>
> | 改动 | 触发它的真实事故 |
> |---|---|
> | §3 变异探针的**路径修正**（`scripts/repro/probe-*-mutations.mjs`）+「每个探针之间必须 `pnpm build`」 | 发 v1.16.1 时**照旧路径敲不到文件 ⇒ 整条门禁被漏跑**；补跑发现探针还原 `src/` 却不重建 `lib/`，连跑会出**假红**（单跑 0/4，`pnpm build` 后 83/83） |
> | §0.2 增加**范围表**（发版前必须填） | v1.16.1 一个版本塞了 5 件事（工作区双模式 / 面板收敛 / 2 处 UI 修复 / 依赖对齐 / README 重写），本条当时被自己绕过去了 |
> | §7 **重写"发布成功"的判据**：tarball 200 + `sha1 == dist.shasum` + 用户视角安装 | v1.16.1 发布时客户端超时，服务端留下"元数据在、包体不在"的中间态：`GET /<pkg>/<ver>` 返回 **200**、npm 网页对维护者显示 **"Published" 且列出 `<ver> = latest`**，而 **tarball 是 404** —— 差点据此宣告发布成功 |
> | §6/§10 增加「**发布命令不许继承代理**」 | 同一事故的起因：`git push` 用的 `HTTPS_PROXY` 被同一条命令里的 `pnpm` 继承，registry 请求在传输途中被掐断 |
> | §11 新增 **npm 平台变更（2026）** | bypass-2FA token 正在被剥夺直接发布能力；发布时会出现 staged/409 等新形态报错 |
>
> 边界：本 skill 只管**从"代码好了"到"用户能在 GitHub / npm 上拿到"**这一段。
> **装进本机 profile 并重启**归 `dsh-safe-plugin-ops`（用户级 skill，`~/.dsh/skills/dsh-safe-plugin-ops/`，
> 项目内没有副本，**按名字引用而不是按路径**）。
> 编码规范与回归防线归项目级 [`dsh-plugin-change`](../dsh-plugin-change/SKILL.md)。
>
> ⚠️ **本文件是「本项目生效的那一份」**：技能根目录按 rank 取值，
> `<projectRoot>/.dsh/skills`（rank 100）**遮蔽** `$DSH_HOME/skills`（rank 400）。
> 通用改动请同时回流到跨项目源仓库 `Dely0/dsh-private-toolkit`（本机克隆在用户主目录下的同名目录，
> 具体路径按机器不同，**别把真实路径写进仓库** —— `scripts/check-pii.mjs` 会命中），
> 否则两边漂移，别的项目用的还是旧规矩。

## 触发条件

- 改 `package.json` 的 `version`、`git tag`、`git push`、`pnpm publish`；
- 在 GitHub 上建/改 Release、写 Release Notes；
- 用户说「发版 / 发布 / 出新版 / 打 tag / 推到 npm / 发到 GitHub」。

**不适用**：只写业务代码、只装盘到本机 profile（→ dsh-safe-plugin-ops）。

## 第 0 条：前置铁律（来自 v1.13.x 与 v1.16.1 的复盘，**比下面所有细节都重要**）

### 0.1 发布与验证**解耦**：没经用户实测，不许 publish / Release / 打 tag

（来源：团队记忆 `01M2A08YG35QQ3KXEJY5C7BZRH`、`01M2A08XX49YNA472F9SEST8MS`，v1.13.0–1.13.1 的教训）

**顺序**：本机 dev 装盘 / 热重载 → **用户实测确认** → 才 `publish` / `Release` / 打 tag。
`docs/release-checklist.md` 要把「**用户已确认**」列为**发布前置项**。

⚠️ **"哪个实例上确认的"要写清楚**：v1.16.1 的用户确认发生在**隔离测试实例**上，
桌面端实例从未装过本版 —— 这是允许的（用户明确要求发版），但**发布说明里不能写成"用户实例已实测"**。
为什么这条最硬：**npm 与 GitHub Release 都不可撤销**，而 UI 类改动最需要肉眼确认 ——
偏偏 DSH Web 有 activation token 鉴权（`/` 与 `/plugins/*` 返回 401），**agent 侧无法免登录打开 GUI**，
所以"我这边跑通了"永远不等于"用户那边对了"。

> ⚠️ 我自己违反过：v1.15.2 / v1.15.3 / v1.15.4 都是**在用户重启实测之前**就 publish + Release 了。
> 那几批改动恰好没出事，但那是运气 —— 本 skill 落地后按本条执行。

### 0.2 一个版本一个主题，最多夹带一件 —— 并且**发版前把范围表填出来**

（同一复盘）**范围蔓延是本项目最大的返工源**：某父任务只定义两条主线，实际交付横跨五个版本。
本 skill 落地那次的 v1.15.2 也犯了；**V1.2.0 那次（v1.16.1）又犯了**。

做法：动版本号**之前**，先在 Release Notes 里落一张表，填不出来就别发：

| 列 | 说明 |
|---|---|
| 本版主题 | **一句话**。写不出"一个主题"→ 说明该拆版本 |
| 主线变更 | 主题内的条目（可多条） |
| 夹带项 | 最多 **1** 件；写清"为什么必须同版" |
| 被推迟/Sibling 任务 | 明确不放进本版的，挂到别的任务 |

> 反面教材（v1.16.1）：5 件事一次发（工作区双模式 / 面板收敛 / 2 处 UI 修复 / 依赖对齐 / README 重写）。
> 用户当时一次性提了多项，所以"同版"有现实理由 —— 但**理由必须写进 Release Notes**，
> 而不是让范围静默膨胀。

### 0.3 版本链路一次做完：tag + Release + 包哈希必须同一次交付

（同一复盘第 9 条）历史上出过 **v1.13.2 没有 tag**、1.11.0–1.12.1 三个版本挤在同一提交。硬要求：

- `package.json` 的 `version`、git tag、npm 上的版本、GitHub Release 的 tag —— **四者必须一致**；
- 每次 publish **同时**给出：tag + Release + **包哈希**（`npm view <pkg>@<ver> dist.shasum`）；
- 用 `git describe --tags` 对一次账，确保产物真能从某个 tag 复现
  （tag 之后再有文档提交是正常的，`describe` 会显示 `v<ver>-N-g<hash>`，**代码要能回到 tag 那一点**）；
- 在 `docs/releases/v<ver>.md` 里落一张**发布产物表**（版本号 / tag / npm / Release URL / 提交 / 包哈希 / 文件数）。

## 第 0b 条：再分清"三个版本号"与"三个动作"

| 概念 | 谁在用 | 判据 |
|---|---|---|
| **代码版本号**（`package.json` 的 `version`） | npm 与用户 | 只在**公开发布**时增长 |
| **本地迭代身份**（`_local-build/<pkg>-dev-<短hash>-<时间戳>.tgz`） | 本机 profile | 每次装盘都换新路径，**不消耗版本号** |
| **git tag `v<version>`** | 仓库 | 与 `version` 一致 |

| 动作 | 效果 | 易错点 |
|---|---|---|
| `git push origin main` | 代码上去 | — |
| `git push origin v1.2.3` | **tag** 上去（`/tags` 页可见） | **不代表建了 Release** |
| `POST /repos/{o}/{r}/releases` | **Release** 条目（`/releases` 页可见） | 只有这个动作才会让那页更新 |

> ⚠️ **`git tag` + push ≠ 建了 Release**（犯过：只推了 tag，用户打开 `/releases` 说"还是上一版"）。
> 验收判据永远是 `GET /repos/{o}/{r}/releases/latest` 指向新版本。

## 第 1 条：什么事才配"发一个版本"

**只有代码/产物（`lib/` 会变的东西）才发版。**

- 只改**文档 / 注释 / 配置 / 测试**（"非编译内容"）→ **不要单独发版**，
  改动留在工作区，**跟随下一个有代码改动的版本一起发布**。
  （犯过：为补一句 README 致谢单独发了 `v1.15.4`，整整一个版本号只装了一句致谢 —— 用户明确纠正。）
- 反面的事实也成立但**不能据此发版**：npm 页面渲染的是**包内 `README.md`**，
  且 npm **不允许覆盖已发布版本**（同版本重发 403）。
  ⇒ 这条的正确用法是**发版前把文档核对干净**，不是"事后补发一个空版本"。
- 一个"空版本"的唯一合法场景：schema/产物必须重发才能修的安全问题。除此之外宁可攒着。

## 第 2 条：Release Title 只写版本号

- `name`（就是标题）= **`v1.2.3`**，**不要**加破折号与描述（犯过：写成 `v1.15.2 — 今日容量规则透明化…`）。
- 主题、变更、验收方式全部放 **body**；`## 主题` 那一段属于 body，不属于 title。
- Body 建议按序：**范围表 → 来源与致谢 → 需求/Issue 对照表 → 逐条变更 → 破坏性变更 → 依赖边界 →
  验收方式 → 发布产物表 → 已知问题 → 相关文档**。
- 若本版夹带了此前积累的文档修正，**在 body 里一并说明**，别让它静默搭车。

## 第 3 条：标准发布序列（不可调换）

```powershell
# 0) 前置自检：**一条命令跑完所有机械门禁**（本仓库的 scripts/release-preflight.mjs）
#    typecheck → 全量单测 → 全部变异探针（每个之间自动 pnpm build）→ PII 两面 → 版本号与文档就位
#    欠账名单外的任何红都会 exit 1（见脚本头部说明：欠账必须显式登记，且还清了也会红）
node scripts/release-preflight.mjs
#    只想跑某一项时：--only typecheck|tests|probes|pii|version
#    ⚠️ 发布命令**单独执行**，别和 git push 混在一条里 —— 见第 6 条
Remove-Item Env:\HTTPS_PROXY,Env:\HTTP_PROXY,Env:\ALL_PROXY -ErrorAction SilentlyContinue

# 1) 范围表 + 版本号（只在这一步动 version）
#    改 package.json 的 version；用 write/edit 工具或 [IO.File]::WriteAllText(..., UTF8Encoding($false))
#    ⚠️ 绝不用 PS 5.1 的 Out-File/Set-Content -Encoding utf8（写 BOM → JSON.parse 直接抛错）

# 2) 文档先就位（**这一步漏了就只能靠新版本号补，见第 1 条**）
#    README.md：版本历史加一行；若本版合入了外部贡献 → **致谢段（中英双段）**同时写
#    THIRD_PARTY_NOTICES.md：登记外部作者代码（来源链接 + 许可证 + 逐项说明）
#    docs/releases/v<version>.md：完整 Release Notes（含范围表）
#    改完版本号与文档后**再跑一次** preflight（第 5 项就是查这三处）

# 3) 发版前检查（PII 已由 preflight 第 4 项覆盖：两个面都扫）

# 4) 提交 → 推送 → 打 tag → 推 tag
git add -A; git commit -m "release: v<version>"
git push origin main                                        # 这一步才需要代理（第 6 条）
git tag -a v<version> -F <msgfile>                          # 注释 tag，msg 写本版要点
git push origin v<version>

# 5) npm（凭据见第 5 条；**放在 tag 之后**，因为 npm 不可撤销，前面任何一步失败都还能改）
pnpm publish --no-git-checks --access public

# 6) 发布后复核：**一条命令**（dist-tags → tarball 200 + sha1 对账 → 用户视角安装 → GitHub releases/latest）
node scripts/release-preflight.mjs --phase post --version <version>

# 7) GitHub Release（用脚本，别手搓 JSON）；建完可再跑一次 --phase post 复核 latest
pwsh -File scripts/new-github-release.ps1 -Tag v<version> -BodyFile docs/releases/v<version>.md
```

> **顺序为什么是这样**：npm 不可撤销 ⇒ 排在最后；GitHub Release 可编辑 ⇒ 排在其后；
> **文档必须排在发版动作之前**，否则就得靠一个新版本号去送达（第 1 条）。

**变异探针这条门禁怎么用**（V1.2.0 修正）：

- 本项目在 **`scripts/repro/probe-*-mutations.mjs`**（不是 `scripts/`），由 `release-preflight.mjs` 统一驱动，
  **每个探针之间会自动 `pnpm build`** —— 探针只还原 `src/` 而**不重建 `lib/`**，
  连着跑会把上一个变异体的构建产物留给下一个，跑出**假红**（实测：单跑 0/4，`pnpm build` 后 83/83）。
- **红=判据有效，绿=该处行为没有测试守得住**。全绿 ≠ "测试全过"，而是**变异存活**。
- 探针打印 `找不到替换片段（探针失效，需更新）` = **探针本身失效**（重构搬动了它锚的源码字符串）。
  **失效的探针等于没有探针** —— 会被 preflight 直接判为阻塞项，不能当成"本来就绿"。
- 仓库里同时存在**两种汇总约定**（`✅ N/N 条变异都被断言抓到` 与 `变异探针：N/M 条变异都变红`），
  preflight 两种都认；**认不出的格式按不通过处理**。
- 红/绿衡量的是**判据能不能拦住未来回归**，不是"当前代码对不对"。
  已知盲点要**显式登记**在 `scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 里（带理由 + issue）；
  **还清了也必须从名单删掉**，否则 preflight 会红。

## 第 4 条：发版前必须扫"私人信息"，而且要**分两个面**扫

（犯过：真实 Windows 账号名、公司名、本机绝对路径留在仓库里；只扫仓库、漏扫了会随包发布的产物。）

```powershell
node scripts/check-pii.mjs            # 本项目的扫描器：默认 both（两个面都扫）
node scripts/check-pii.mjs tracked    # 只扫 GitHub 面（git 跟踪的全部文件）
node scripts/check-pii.mjs dist       # 只扫随包面 lib/**（需先 pnpm build）
```

三条纪律：

1. **扫描面 ≠ 一个**：`docs/` `test/` `scripts/` 只影响 GitHub；而 `lib/**` 是**编译产物** ——
   源码里的一句 JSDoc 注释会原样进 `lib/*.js` 与 `lib/*.d.ts`。**两个面都要扫**。
2. **扫描器的命中要逐条人工判断**：命中的可能是合法文案（测试里的占位家目录、讲凭据规范的说明文字），
   **别一键全删**；但"某条规则 0 命中"要先怀疑规则写错（转义反斜杠），别当成"本来就干净"。
3. **替换/改名完立刻跑测试**：会连带改到测试夹具里的路径与断言文本。

私钥/token 类（`api_key`/`secret`/`password`/`BEGIN … PRIVATE KEY`/`npm_…`/`ghp_…`/`sk-…`）也必须一并扫。

## 第 5 条：凭据（两条链，各自的位置都不同）

**本机现状**（换机器先重新确认；**这些路径与端口都是本机特有的，不要抄去别的机器/仓库**）：

| 用途 | 凭据 | 注意 |
|---|---|---|
| npm publish | `<凭据目录>/.npm_token.txt`（默认 `~/.dsh/team-keys/`），形如 `npm_…` | **不在 `~/.npmrc`**（`npm whoami` 会报 ENEEDAUTH） |
| GitHub API | `<凭据目录>/.gh_token.txt` 的 `GithubToken=` | **fine-grained PAT：权限逐项勾选** |
| GitHub 写 Issue / 改 Release 标题 | `git credential fill` 取回的 **`gho_`** | fine-grained PAT 常缺 `Issues` 写权限（403） |

> 脚本按 `$env:DSH_TOKEN_DIR` 找凭据目录、按 `$env:DSH_GITHUB_PROXY` 找代理；
> 两个环境变量都没设时才用本机隐含默认。**换机器只设这两个变量，不要改脚本。**

```powershell
# npm：写到**仓库外**的临时 userconfig，用完即删，全程不回显
$tmp = Join-Path $env:TEMP "wb-npmrc-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$t = (Get-Content "<凭据目录>/.npm_token.txt" -Raw).Trim()
if ($t -notmatch '^npm_[A-Za-z0-9]{20,}$') { throw 'token 形态不对' }
[IO.File]::WriteAllText($tmp, "registry=https://registry.npmjs.org/`n//registry.npmjs.org/:_authToken=$t`n", [Text.UTF8Encoding]::new($false))
$env:NPM_CONFIG_USERCONFIG = $tmp          # ⚠️ pnpm **不认** --userconfig（报 Unknown option）
pnpm whoami                                # 先核身份
# …publish…
Remove-Item $tmp -Force; Remove-Item Env:\NPM_CONFIG_USERCONFIG
```

**硬要求**：token 只放仓库外、**绝不 echo**、用完即删；发布后确认仓库内无 `.npmrc`。

> ⚠️ **2026-10-05 起：`npm publish` 这一条链走的是「会话身份 + 交互式 2FA」，不是令牌。**
> bypass-2FA 令牌**已经发不出去了**（只会 stage，见 §11）—— 上表里 npm 令牌那条现在只用于
> `npm whoami` / `npm view` / 直连 registry 这类**只读核对**。发布时**不要**设 `NPM_CONFIG_USERCONFIG`（那会把身份切成令牌），
> 直接在用户自己的终端里 `npm publish --access public` 并输入 2FA 验证码；AI 不得索要 OTP。

## 第 6 条：本机网络现实（会伪装成 git / npm 故障）

- `github.com:443` **直连不通**，必须给**那一条命令**临时加：
  `$env:HTTPS_PROXY="http://127.0.0.1:5782"`（FaceTheWorld SSR）。**不要写进全局 git 配置**。
- ⚠️ **代理绝不与发布命令同处一条命令 / 同一个进程**（V1.2.0 新增，v1.16.1 的真实事故）：
  `git push` 设的 `HTTPS_PROXY` 会被同一条命令里随后运行的 `pnpm` / `npm` **继承**，
  于是 registry 请求也走那个（给 GitHub 用的）代理 → **在传输途中被掐断**，
  服务端留下"版本元数据已写、tarball 未落"的**中间态**（见第 7 条）。
  ⇒ 发布前显式清：`Remove-Item Env:\HTTPS_PROXY,Env:\HTTP_PROXY,Env:\ALL_PROXY`；
    或者**分成两条命令**执行。
- 代理会间歇抖动：`TLS connect error ... unexpected eof while reading` / `Recv failure: Connection was reset`
  → **退避重试 1–3 次即成功**，不要改配置、不要换远端。
- `api.github.com` 通常比 `github.com` 稳；`raw.githubusercontent.com` 可能整个不通
  → 取文件改用 `GET /repos/{o}/{r}/contents/{path}`（解 base64）。

## 第 7 条：判"发布成功"的判据（**V1.2.0 重写：只信 tarball**）

**退出码 0 不算、网页显示 "Published" 也不算。** 按这个顺序查：

```powershell
# ① tag 面
npm view <pkg> version                       # 新版本
npm view <pkg> dist-tags --json              # latest 指向它

# ② 包体面（**决定性**）：tarball 必须 200，且 sha1 与 registry 记录逐字节一致
$m = (Invoke-WebRequest "https://registry.npmjs.org/<pkg>/<ver>" -UseBasicParsing).Content | ConvertFrom-Json
curl.exe -sSL -o x.tgz $m.dist.tarball
(Get-FileHash x.tgz -Algorithm SHA1).Hash.ToLower() -eq $m.dist.shasum    # 必须 True
# 解包核对：包内 README 是最新的、lib/ 齐全、不含 docs/test/scripts

# ③ 用户面：空目录 + **全新缓存** 装一次（不指定版本，走 latest）
npm i <pkg> --cache <全新临时目录>            # 必须成功
```

**⚠️ 哈希要比"哪一份"**：上面的 sha1 必须哈希 **`$m.dist.tarball` 下回来的那一份**，
**不是**本地 `npm publish` 打在 `Tarball Details: shasum:` 的那个值 —— 两者不同**不代表内容不同**。
v1.16.5 实测：本地算 `8c3c10f74d0d7bb32c4df82d19f26a1932e6d2cf`、registry 是 `130d4e7b7a17c316666bfc1b169c16021137ac45`，
而包内 `lib/**`（240 个文件）、`cordis.patch.yml`、`README.md`、`THIRD_PARTY_NOTICES.md` 与本地构建
**SHA256 逐一相同**、`lib/build-info.json` 的 `buildId` 也一致 —— 差异只来自包内 `package.json` 少了
`packageManager` / `prepare`（本仓历来的发布形态，1.16.2 / 1.16.3 / 1.16.4 同样如此）。
要回答"上线的是不是我构建的那份"，用**逐文件哈希 + buildId**，别用 tarball 字节哈希。

**三个会骗人的信号**（v1.16.1 实测，v1.16.5 补一行）：

| 信号 | 真相 |
|---|---|
| `pnpm publish` 退出码 0 | 只说明**客户端**没报错；传输中断时它也返回非 0，但**超时后服务端可能已留下中间态** |
| **`✅ Published package` 这行输出**（`pnpm` 与 `npm` 都会打；v1.16.5 是 `pnpm` 打的） | 只说明**那次 PUT 没抛错**。npm 2026 的 staged publishing 下，不带 2FA 的提交会**进暂存区**而不是公开：v1.16.5 打了这句，registry 上版本端点仍是 404、tarball 404、`latest` 还是上一版 |
| npm **网页**对维护者显示 **"Published"** + `Current Tags: <ver> = latest` | 中间态也会这样显示。**只有 tarball 能下载才算数** |
| `npm view <pkg>@<ver>` / `npm i` 报 `E404` / `notarget` | 可能命中**本地 npm 缓存**；同一时刻 `curl` 直连原站可能已经最新。**用 `curl` 直连裁决** |

**中间态长什么样、怎么办**（v1.16.5 实测补全）：

- 症状（两种形状都见过）：
  - **形状 A**（v1.16.1）：`GET /<pkg>/<ver>` 返回 **200**（元数据在），而 `…-<ver>.tgz` 返回 **404**；
  - **形状 B**（v1.16.5）：`GET /<pkg>/<ver>` **也是 404**（`"version not found"`）、tarball 404，
    而其余一切正常：packument 里 `versions` 不含它、`dist-tags.latest` 没动。
  - 两种形状的共同点：**`dist-tags.latest` 没动**。先查它，一眼分辨"发了"还是"没发"。
  - ⚠️ 别被 CDN 缓存骗到：加 `?cb=<随机>` + `Cache-Control: no-cache` 再查，看到 `CF-Cache-Status: MISS`
    且 `Last-Modified` 早于本次发布 ⇒ origin 真的没变。
- 重发会得到 `409 Cannot publish over previously staged version "x.y.z"`（措辞会变，**别按字面理解成"进了暂存区等人批准"**）：
  此时 `npm stage list` 往往是**空的** —— v1.16.5 实测**两种身份都是空**（会话身份这次不报 `E401`，
  而是 `200` + `[]`；端点就是 `GET /-/stage?page=0&perPage=100&package=…`），
  即**根本没有 stage-id 可 `approve/reject`**，"去 approve 一下"这条退路不存在。
- **解法**（v1.16.5 就是这样落地的）：在**正确目录**用**会话身份**（`npm login`，2FA）
  **交互式**重发一次 `npm publish --access public`（用 `npm`，不要用带 bypass 令牌的 `pnpm`），
  让那次暂存提交**补完**；其后 tarball 还可能有**数分钟到十几分钟的边缘传播延迟**，退避重试即可。
  v1.16.5 的实际落地时间是 `12:51:57Z`，**早于**命令自己报错的时间 —— 别用"命令返回了什么"推断服务端状态。
- 🔎 **会伪装成失败的字符串**：`npm error You cannot publish over the previously published versions: <ver>.`
  —— 它意味着 registry **认为该版本已在册**（客户端的前置检查）。看到它先查 `latest` 与 tarball，很可能已经成功了。
- 仍不行的兜底：换一个版本号发（npm 文档明确"有 staged 待批准时仍可正常发布其他版本"），
  或找 npm support 释放该版本号（用户侧无自助入口）。

- **`npm pack` 拉回真实产物复核**：包内 `README.md` 是最新的、不含 `docs/` `test/` `scripts/`、无私人信息。
- **profile 要不要跟着切到 npm 版**：本地迭代用 dev tgz、正式版用 npm；
  切了要再装一次并**由用户重启**（重启绝不自行发起）。

## 第 8 条：合入外部 PR 的收尾（很容易留下半拉子状态）

- **保留作者署名**：`git fetch origin pull/<n>/head:pr-<n>` → `git cherry-pick pr-<n>`。
  自己的改判**单独一个提交**，别把"原稿"和"改判"揉成一个。
- ⚠️ **`cherry-pick` 不会让 GitHub 把 PR 标记为已合并**（`merged=False`，PR 停在 open）。
  ⇒ 要**主动**在 PR 上留言说明落地方式、再 `PATCH /pulls/<n> {state:'closed'}`；
  想让贡献显示为紫色 Merged，就得走真正的 merge commit。
- 合入时就**同步写致谢**（README 中英双段 + THIRD_PARTY_NOTICES），别留到发版。
- `git apply --check` 报冲突 **≠** cherry-pick 会冲突：cherry-pick 用原提交的 parent 做 3-way 基线，
  常常能自动解掉。

## 第 9 条：编码坑（团队记忆里这类事故最多，而且**两个方向的规则正好相反**）

发布链条要写两类文件，**它们的编码要求是反的**：

| 要写的文件 | 要求 | 写错会怎样 |
|---|---|---|
| `package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml` / `settings.yaml` / 任何被 `JSON.parse` 读的 | **必须无 BOM**（`EF BB BF` 是致命的） | Node 直接抛 `SyntaxError: Unexpected token ''` → **DSH 整个起不来、GUI 也进不去**，连"用 GUI 自救"都没了 |
| 被 **Windows PowerShell 5.1**（`powershell.exe`）执行的 `.ps1` | **要么纯 ASCII，要么带 BOM** | 无 BOM 时 5.1 按 **ANSI/GBK** 解码 UTF-8 中文字节 → 语法错误。**更坑的是脚本"秒退"但外层返回码仍是 0**，看起来像没跑（`Invoke-CimMethod Win32_Process Create` 会给 PID） |

- **写第一种文件**：只用 `write`/`edit` 工具，或
  `[IO.File]::WriteAllText($p, $s, [Text.UTF8Encoding]::new($false))`。
  **绝不用 PS 5.1 的 `Out-File` / `Set-Content -Encoding utf8`**（那是 UTF-8 **with BOM**；`pwsh` 7 才是 no-BOM）。
- **写第二种文件**：把 `#Requires -Version 7` 放在脚本第一行 ——
  这样它只会被 `pwsh` 7 执行（`pwsh` 读无 BOM UTF-8 中文没问题），5.1 会直接拒绝而不是乱码乱跑。
  本仓库的 `scripts/new-github-release.ps1` 就是这么做的；调用时**用 `pwsh -File …`，不要用 `powershell -File …`**。
- **`edit`/`write` 工具会剥掉 UTF-8 BOM**（实测），所以"手工在终端测是好的、被工具改过就乱码"这种差异，
  第一反应就该查 BOM。
- **判据**：报错原文里出现 `Unexpected token ''`（那个不可见字符）→ 立刻查该文件头 3 字节是不是 `EF BB BF`。

## 第 10 条：不许做的事

- **不许发版了再说"文档没写"**（第 1 条）—— 先想清楚这次到底改了什么。
- **不许在用户实测确认之前 publish / Release / 打 tag**（第 0.1 条）。
- **不许在没跑测试的情况下 `pnpm publish`**（npm 不可撤销）。
- **不许把发布命令与带代理的 `git push` 放在同一条命令里**（第 6 条，V1.2.0 新增）——
  同进程的环境变量会被包管理器继承。发布前显式清 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`。
- **不许用"退出码 0"或"npm 网页显示 Published"宣告发布成功**（第 7 条）——
  判据是 **tarball 200 + `sha1 == dist.shasum` + 用户视角装得上**。
- **不许自行重启 DSH**（那是用户的操作，见 dsh-safe-plugin-ops）。
- **不许用 `pnpm install` 代替 `dsh plugin add`** 来刷新装盘产物（同路径会复用已解包文件）。
- **不许把 token 写进命令行参数**（会进 shell 历史），只走环境变量或请求头。

## 第 11 条：npm 平台变更（2026，会以"莫名其妙的报错"形式出现）

- **bypass-2FA 粒度令牌（GAT）已不能直接发布**（v1.16.5 的 2026-10-05 实测，不再是"预告"）：
  账户/包管理类操作 2026-08 起已要求交互式 2FA；用它跑 `pnpm publish` **退出码 0、还会打印
  `✅ Published package`，实际只把版本送进暂存区**。npm 自己会打一条 deprecation notice
  （<https://gh.io/npm-gat-bypass2fa-deprecation>）—— **看到这条通告就别再指望这个令牌能把包发出去**。
  现在的分工：**发布交给人（会话身份 + 交互式 2FA）**，令牌只用来做只读核对。
- **staged publishing**：token 执行 `npm stage publish`（不需要 2FA）→ 维护者
  `npm stage list` 拿 stage-id → `npm stage approve <id>`（**需要 2FA**）才真正公开。
  规则：staged 版本与已发布版本**共用同一个 semver 唯一索引**；tag 是 stage 的不可变属性。
  文档：<https://docs.npmjs.com/staged-publishing>、<https://docs.npmjs.com/cli/v12/commands/npm-stage/>
- ⚠️ **但别指望 `stage list` 一定给你 stage-id**：v1.16.3 那次报 **`E401 /-/stage`**；
  v1.16.5 这次**两种身份都是 `200` + 空列表**（端点 `GET /-/stage?page=0&perPage=100&package=…`）
  ⇒ 没有 id 可 approve。**能救回这个版本号的只有"交互式重发一次"**（§7 中间态的解法）。
- **长远方向**：把自动化发布迁到 [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers)。
- **团队记忆里的对应条目**：`01M461R901F3J97W3R0194YJ1Y`（v1.16.5：`✅ Published package` 是假的、
  409 文案、stage list 空、以及"已在册"那句伪装成失败的话）、`01M42QXX61GHWGQHT8WX9V6FTT`（v1.16.3 同源）、
  `01M3W3ZXQD5FVEBVWW3EAVCZTA`（判据与中间态）、
  `01M3EY1JEP5CQTQ6DP682DR0BV`（packument 先到、tarball 滞后）、
  `01M3W4WJQHYBKYD1TCZ8G8BKDT`（变异探针的 `lib/` 污染假红）。

## 速查：发版前 10 秒自检

1. **用户实测确认过了吗？在哪个实例上确认的？**（第 0.1 条 —— 没过就别往下走）
2. **范围表填出来了吗？**本轮只有一个主题？夹带项 ≤1 且写了理由？（第 0.2 条）
3. `pnpm typecheck` 0、`pnpm test` fail 0 且用例数 ≥ 上一版？
   **变异探针全跑了吗（每个之间 `pnpm build`）？有存活/失效项吗？**（第 3 条）
4. 这次**真有代码改动**吗？（只有文档 → 不发版，攒着）
5. `package.json` 版本号改了吗？写盘后头 3 字节不是 `EF BB BF`？
6. README 版本历史 + 致谢 + `THIRD_PARTY_NOTICES` + `docs/releases/v<ver>.md` 都写完了吗？
7. PII：`check-pii.mjs` 两个面都扫了吗？命中逐条判断过了吗？（第 4 条）
8. tag 打了**并推了**吗？
9. **发布命令单独执行、代理已清？用「会话身份 + 交互式 2FA」发的吗？**（第 5、6 条 —— bypass 令牌现在只会 stage）
   publish 之后：**tarball 200 且 `sha1 == dist.shasum`**（哈希的是 **registry 下回来的那份**）、
   拿到包哈希了吗？**`✅ Published package` 不算成功**（第 7 条）
10. **Release 建了吗**（不是只推 tag）、Title **只写版本号**、`releases/latest` 指向它？
11. `npm pack` 拉回真实产物复核过？**用户视角 `npm i`（全新缓存）装得上？**
    profile 要不要切、要不要让用户重启？

## 参考

- 本机 DSH 环境事实与装盘门禁：`dsh-safe-plugin-ops`（用户级 skill，`~/.dsh/skills/dsh-safe-plugin-ops/`；本项目内没有副本）
- 建 Release 的脚本（Title 硬校验、UTF-8 正文、凭据回退、`latest` 复核）：
  [`scripts/new-github-release.ps1`](../../../scripts/new-github-release.ps1)（**用 `pwsh -File` 调**）
  —— 本仓库只有**这一份**，不要再往 skill 目录里放副本（跨项目用的那份在私有工具库
  `Dely0/dsh-private-toolkit` 的 `skills/dsh-release/scripts/` 下，与这份各自独立、都在用）。
- 项目级编码规范与回归防线：[`dsh-plugin-change`](../dsh-plugin-change/SKILL.md)
- 发版前自检清单（清单化版本、含 §7 判据）：[`docs/release-checklist.md`](../../../docs/release-checklist.md)
- 变异探针待修清单：[`docs/issues/2026-10-01-mutation-probe-maintenance.md`](../../../docs/issues/2026-10-01-mutation-probe-maintenance.md)
- 团队记忆里的原始教训（可检索）：`01M2A08YG35QQ3KXEJY5C7BZRH`（发布与验证解耦等 11 条）、
  `01M2A08XX49YNA472F9SEST8MS`（8 项流程问题）、`01M2FAD302RC2MKVE3W0Z1S0E7`（BOM → DSH 起不来）、
  `01M2HQSZD13DM75EA1V9CDTGRP`（PS 5.1 按 ANSI 读无 BOM 脚本、秒退但返回码 0）、
  `01M2JZCGJ58YHWYARAN25MT9RH`（细粒度 PAT 缺 Issues 写权限）、
  `01M2K6ADYSSPHXXAW083ZZ7K1D`（git push 走 127.0.0.1:5782 代理）、
  `01M2PHD02QSHBZHJBYATMZCFC0` 类"静默失败"通例（**命令返回 0 不等于真的做成了**）
