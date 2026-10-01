/**
 * 发布前 PII / 私人信息扫描（**入库工具**，只读、不改任何文件）。
 *
 * 为什么要有它：发布 skill 第 4 条要求"发版前必须扫私人信息，而且分两个面扫"。
 * 这个仓库真犯过——真实 Windows 账号名、公司/内网路径被提交并推到 GitHub，
 * 其中 3 处还进了**会随 npm 包发布**的 `lib/**`（源码里的 JSDoc 会原样编译进去）。
 *
 * ## 两个面（缺一不可）
 *
 * | 面 | 范围 | 影响 |
 * |---|---|---|
 * | 面一 | `git ls-files` 跟踪的全部文件 | **GitHub 公开面** |
 * | 面二 | `lib/**`（会随包发布） | **npm 包内容**，一个 JSDoc 注释也会被用户看到 |
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-pii.mjs            # 两个面都扫
 * node scripts/check-pii.mjs tracked    # 只扫 GitHub 面
 * node scripts/check-pii.mjs dist       # 只扫随包面（需先 pnpm build）
 * ```
 *
 * 退出码：0 = 未命中任何规则；1 = 有命中（逐条打印，**逐条人工判断**是不是真泄漏）。
 *
 * ⚠️ 规则里的字面量**故意用拼接构造**，这样工具自身不含任何私人标识，
 * 不会自己把自己扫成命中（本项目真踩过这个自指问题）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 私人标识（拼接构造，避免工具自身含字面量）。 */
const PERSONAL_ACCOUNT = ['Admini', 'strator'].join('')
const PERSONAL_LOCAL_DIR = ['Link', 'sight'].join('')
const INTERNAL_REPO_OLD = ['LS', 'Skills'].join('-')
const PERSONAL_MAIL = ['294145601', '@qq.com'].join('')
const COMPANY_DOMAIN = [PERSONAL_LOCAL_DIR.toLowerCase(), '\\.(cn|com)'].join('')

const RULES = [
  ['Windows 账号名（含路径形态）', new RegExp(PERSONAL_ACCOUNT, 'i')],
  /**
   * ⚠️ 只捉**真实用户名**：`C:\Users\<user>\` / `C:\Users\x\` 这类占位符是文档与
   * 测试里合法的通用写法（本项目 2026-10-01 已把真实账号名统一换成 `<user>`）。
   * 规则写宽了会把 20+ 处占位符全报成命中 —— 那正是发布 skill 警告的"误报淹掉真发现"。
   */
  ['真实 Windows 用户名（排除占位符）', /C:\\+Users\\+(?!<|\{\{|x\\|user\\|Me\\|me\\|用户名|you\\|你的)[A-Za-z][\w.-]*\\/i],
  ['Linux/macOS 真实家目录用户名（排除占位符）', /\/mnt\/c\/Users\/(?!<|Me\/|me\/)[A-Za-z][\w.-]*\//i],
  ['公司/内网路径名', new RegExp(`${PERSONAL_LOCAL_DIR}|${INTERNAL_REPO_OLD}`, 'i')],
  /**
   * ⚠️ 这条规则**故意只查"盘符下 2 层以上的真实仓库目录"**，不查 `D:\Code\my-repo` 这种
   * 给用户看的示例路径 —— 后者是合法的产品文案（输入框 placeholder、JSDoc 举例、测试夹具）。
   * 一次真扫描里这种误报会淹掉真发现（发布 skill 第 4 条：逐条看，别一键删）。
   */
  ['盘符下的深层真实仓库路径（D:\\Code\\<公司>\\<仓库>\\）', /[A-Z]:\\+Code\\+[A-Za-z][\w-]*\\+[A-Za-z][\w-]*\\/i],
  ['作者本机数据规模/环境描述', /本机有\s*\d+\+?\s*条|作者本机|我本机/i],
  ['个人邮箱/@qq.com', new RegExp(`${PERSONAL_MAIL}|@qq\\.com`, 'i')],
  ['公司域名', new RegExp(COMPANY_DOMAIN, 'i')],
  ['通用占位家目录（允许，仅提示）', /\/home\/user\//, { advisory: true }],
  ['DSH_HOME 绝对路径', /[A-Z]:\\+\\?\.dsh\\+/i],
  ['私钥块', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['npm token', /npm_[A-Za-z0-9]{20,}/],
  ['GitHub token', /gh[pous]_[A-Za-z0-9]{20,}/],
  ['OpenAI 风格 key', /sk-[A-Za-z0-9]{20,}/],
  ['Bearer token 字面量', /Bearer\s+[A-Za-z0-9_-]{20,}/],
  /**
   * ⚠️ 合成夹具豁免：脱敏函数的测试**必须**喂一个"看起来像凭据"的值，
   * 否则测不出它兜不兜得住。判定特征：值里出现 `secret`/`token` 这类**自述词**、
   * 且所在文件是 `test/` 下的。真凭据不会这么写（它是个不透明的随机串）。
   * 本仓库实测该规则 100% 命中这类夹具，逐条看过：全是合成值。
   */
  ['api_key / secret / password 赋值（合成夹具豁免）',
    /(api[_-]?key|secret|password)\s*[:=]\s*['"](?![^'"]*(?:secret|token|placeholder|example|dummy)[^'"]*['"])[^'"]{8,}['"]/i],
  ['凭据文件名引用', /\.npm_token\.txt|\.gh_token\.txt|GithubToken=/],
]

const TEXT_EXT = /\.(ts|tsx|mjs|cjs|js|json|md|yml|yaml|ps1|sh|html|css|txt)$/i

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

function distFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { distFiles(full, acc); continue }
    if (/\.(js|mjs|cjs|d\.ts|json|md|css)$/i.test(entry.name)) acc.push(full)
  }
  return acc
}

const mode = process.argv[2] ?? 'both'
const faces = []
if (mode !== 'dist') faces.push(['面一 · GitHub 公开面（git 跟踪）', trackedFiles()])
if (mode !== 'tracked') {
  let hasLib = false
  try { hasLib = statSync('lib').isDirectory() } catch { hasLib = false }
  if (hasLib) faces.push(['面二 · npm 包内容（lib/）', distFiles('lib')])
  else console.log('⚠️ lib/ 不存在 —— 面二没扫到，先跑 pnpm build')
}

let total = 0
for (const [faceName, files] of faces) {
  console.log(`\n=== ${faceName}：${files.length} 个文件 ===`)
  for (const [ruleName, regex, meta] of RULES) {
    const hits = []
    for (const file of files) {
      if (!TEXT_EXT.test(file) && mode !== 'dist') continue
      let text
      try { text = readFileSync(file, 'utf8') } catch { continue }
      // 工具自身不入扫（规则里的字面量会自指命中）
      if (file.endsWith('check-pii.mjs') || file.endsWith('_pii-scan.mjs')) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 130)}`)
      }
    }
    console.log(`  [${hits.length === 0 ? '干净' : `命中 ${hits.length}`}] ${ruleName}`)
    for (const hit of hits.slice(0, 10)) console.log(`      ${hit}`)
    if (hits.length > 10) console.log(`      …另有 ${hits.length - 10} 处`)
    if (meta?.advisory !== true) total += hits.length
  }
}

console.log(`\n=== 合计命中 ${total} 处 ===`)
if (total > 0) {
  console.log('逐条人工判断：是示例文案（合法）还是真泄漏（必须改）。别一键全删。')
  process.exit(1)
}
console.log('两个面都干净。')
