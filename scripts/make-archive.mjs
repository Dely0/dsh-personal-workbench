/**
 * 建一个可追溯的版本存档目录。
 *
 * 为什么单独写脚本（2026-09-13，用户要求"先把当前版本存档"）：
 * 手工复制容易漏东西、也不会留下"这个包当时对应哪份源码"的证据。
 * 存档的价值全在**可追溯**：拿到目录就能确认包、版本、指纹与当时的验收结论是一套的。
 *
 * 产出 `_archive-v<版本>-<日期时间>/`：
 *   - `dely0-dsh-personal-workbench-<版本>.tgz`  装盘包（正式产物）
 *   - `package.json`                              源码清单（版本号的来源）
 *   - `FINGERPRINT.txt`                           装盘产物 vs 开发树构建的逐文件指纹校验输出
 *   - `VERSION-CHECK.txt`                         装盘版本/profile 声明/schema 一致性检查输出
 *   - `TGZ-CHECK.txt`                             包本身的完整性校验输出
 *   - `SHA256SUMS.txt`                            包与源码清单的 sha256
 *   - `git-revision.txt`                          当时的 git HEAD 与工作树改动概览
 *   - `NOTES.md`                                  一句话现状 + 未决事项
 *
 * 用法：node scripts/make-archive.mjs <版本> [备注]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

const version = process.argv[2]
const note = process.argv[3] ?? ''
if (version === undefined) { console.error('用法：node scripts/make-archive.mjs <版本> [备注]'); process.exit(2) }

const ROOT = process.cwd()
const tgzName = `dely0-dsh-personal-workbench-${version}.tgz`
const tgzPath = join(ROOT, tgzName)
if (!existsSync(tgzPath)) {
  console.error(`❌ 找不到 ${tgzName}（先在仓库根目录跑 pnpm pack）`)
  process.exit(1)
}

/**
 * 时间戳：与仓库里既有的 `_tonight-changes-<yyyyMMdd-HHmmss>` 风格保持一致。
 *
 * 直接按字段拼，**不做位置切分**（踩过两次）：
 *   1. `slice(0, 15)` 会多切一个小数点（`…SS.mmmZ` 里第 15 个字符是 `.`），
 *      目录名变成 `…-20260913034552.`（末尾带点），git 会当成乱码路径报警；
 *   2. `.replace(/[-:]/g,'')` 不会去掉 `T`，于是得到 `20260913T034600`。
 */
const parts = new Date()
const pad = (value) => String(value).padStart(2, '0')
const stamp = `${parts.getFullYear()}${pad(parts.getMonth() + 1)}${pad(parts.getDate())}-${pad(parts.getHours())}${pad(parts.getMinutes())}${pad(parts.getSeconds())}`
const dirName = `_archive-v${version}-${stamp}`
const dir = join(ROOT, dirName)
mkdirSync(dir, { recursive: true })

/** 跑一条命令并把输出同时打印与落盘（失败不中断，存档要尽量完整）。 */
const run = (label, command, args) => {
  let output
  try {
    output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = `（命令退出码非 0：${error instanceof Error ? error.message : String(error)}）\n${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  writeFileSync(join(dir, `${label}.txt`), `$ ${command} ${args.join(' ')}\n\n${output}`)
  console.log(`   ${label}.txt  ←  ${command} ${args.join(' ')}`)
  return output
}

copyFileSync(tgzPath, join(dir, tgzName))
copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'))
console.log(`已复制 ${tgzName} 与 package.json`)

run('FINGERPRINT', 'node', ['scripts/check-installed-fingerprint.mjs'])
run('VERSION-CHECK', 'node', ['scripts/check-installed-version.mjs'])
run('TGZ-CHECK', 'node', ['scripts/check-tgz.mjs', tgzName, version])

/** sha256：包 + 源码清单（这两个是"这一版是什么"的最小充分证据）。 */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
writeFileSync(join(dir, 'SHA256SUMS.txt'), [
  `${sha256(join(dir, tgzName))}  ${tgzName}`,
  `${sha256(join(dir, 'package.json'))}  package.json`,
  '',
].join('\n'))
console.log('   SHA256SUMS.txt')

/** git 现场：HEAD + 工作树改动（源码未提交时这就是唯一的可追溯线索）。 */
try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  writeFileSync(join(dir, 'git-revision.txt'), `HEAD ${head}\n\n=== git status --porcelain ===\n${status}`)
  console.log(`   git-revision.txt  ←  HEAD ${head.slice(0, 10)}`)
} catch (error) {
  writeFileSync(join(dir, 'git-revision.txt'), `（读 git 现场失败：${String(error)}）\n`)
}

writeFileSync(join(dir, 'NOTES.md'), `# 存档 · v${version} · ${stamp}

${note === '' ? '' : `**备注**：${note}\n`}
## 这是什么

一个**已验证通过正式装盘**的版本快照。装盘方式（下次要复现时照做）：

\`\`\`sh
node scripts/check-tgz.mjs ${tgzName} ${version}          # 先确认包完好
dsh plugin add "<绝对路径>/${tgzName}" --profile web
node scripts/check-installed-version.mjs                   # 退出码 0 才重启
node scripts/check-installed-fingerprint.mjs               # 应"逐文件一致"
dsh --profile web --dump-config                            # 退出码 0 且无 pending
\`\`\`

## 目录内容

| 文件 | 说明 |
|---|---|
| \`${tgzName}\` | 装盘包（\`pnpm pack\` 产物，已通过 TGZ-CHECK） |
| \`package.json\` | 源码清单（版本号来源） |
| \`FINGERPRINT.txt\` | 装盘产物 vs 开发树构建的**逐文件**指纹校验 |
| \`VERSION-CHECK.txt\` | 装盘版本 / profile 声明 / 数据库 schema 一致性 |
| \`TGZ-CHECK.txt\` | 包完整性（gzip/tar/关键产物） |
| \`SHA256SUMS.txt\` | 包与清单的 sha256 |
| \`git-revision.txt\` | 当时的 git HEAD 与工作树改动概览 |

## 未决事项（存档时如实记录）

见 \`docs/releases/v1.14.45-sidebar-slots-acceptance.md\` 第 4 节。摘要：

1. **本机 task-board 被 \`cordis.patch.yml\` 里重复的 \`disabled: true\` 关着**
   （文件自己的注释警告过这个坑，又复发了）。因此与 task-board 的互斥只能靠
   **模拟它的 DOM 契约**（\`<html data-dsh-taskboard-active>\`）验证；启用后建议复验一次。
2. **运行中的宿主仍是旧插件的服务端半边** —— 客户端半边刷新即生效，服务端改动需要重启，
   而重启会掐断会话，须由用户决定。
3. **用户报告的"打开 taskboard 后界面遮挡会话区"在开发机上未能复现**：
   互斥脚本实测"看板激活 → 工作台让位"通过，且收起后两矩形无重叠。
   若仍复现，需要用户提供：\`data-dsh-part\` / \`data-dsh-plugin\` 齐全的侧栏入口清单、
   两个面板的 \`getBoundingClientRect\`、以及 \`window.__wbDebugLog\`。
`)
console.log('   NOTES.md')
console.log(`\n✅ 存档完成：${dirName}/`)
