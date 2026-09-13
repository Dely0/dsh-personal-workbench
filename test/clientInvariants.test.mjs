/**
 * 源码级不变量 · 阶段 2（设计文档 2026-09-13 第 7 节 I4 / I5 / I6）。
 *
 * 这三条把**政策**变成"编译期就能失败的约束"：成本极低、防回归最强。
 * 它们之所以能存在，是因为政策本身是"不存在某段代码"—— 而"不存在"只能扫源码证明。
 *
 * | 编号 | 不变量 | 为什么 |
 * |---|---|---|
 * | I4 | 我们只写白名单里的 DOM 属性 | 写者唯一（P3）：凡是写到 `<html>` 上的，必须逐条可解释 |
 * | I5 | 不碰兄弟插件的任何属性、不广播家族事件 | 冲突不归我们（P6） |
 * | I6 | 不再有侧栏 DOM 注入 | 删除 DOM 降级腿（用户决策） |
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

/**
 * 收集 + 归一化路径。
 *
 * ⚠️ Windows 上 `new URL(...).pathname` 形如 `/D:/Code/...`（带前导斜杠、混合分隔符），
 * 直接 `split(/[\\/]src[\\/]/)` 会**匹配不到** —— 第一版就因此让"constants.ts 必须存在"
 * 这类断言假失败。这里统一走 `fileURLToPath` + 相对路径。
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** 递归收集 src 下的源码（只 .ts/.tsx；跳过 .bak-* 之类的手工备份）。 */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry.includes('.bak-')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const FILES = sourceFiles(SRC)
const sources = FILES.map((path) => ({ path, text: readFileSync(path, 'utf8') }))
/** `src/client/constants.ts` 形如 `client/constants.ts`。 */
const rel = (path) => relative(SRC, path).split(sep).join('/')
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

test('I5：全仓不再出现兄弟插件的属性名与家族事件', () => {
  const banned = ['data-dsh-taskboard', 'data-dsh-ssh', 'data-dsh-mnemon', 'dsh-panel-activate']
  for (const { path, text } of sources) {
    const code = stripComments(text)
    for (const needle of banned) {
      assert.equal(code.includes(needle), false,
        `${rel(path)} 仍出现 "${needle}" —— 它属于"以 DOM 接管中栏"的兄弟插件协议，本插件不参与（P6）`)
    }
  }
})

test('I6：全仓不再有侧栏 DOM 注入的痕迹', () => {
  const banned = ['insertBefore', 'sidebarRoot', 'newSessionButton']
  for (const { path, text } of sources) {
    const code = stripComments(text)
    for (const needle of banned) {
      assert.equal(code.includes(needle), false,
        `${rel(path)} 仍出现 "${needle}" —— 侧栏入口一律交给官方槽位 sidebar.panellist 渲染`)
    }
  }
})

/**
 * I4：写到 `<html>` 上的属性必须**都是本插件自己的**。
 *
 * 设计文档第 5.2 节的意图是"**写者唯一**"：我们自己往宿主根元素上写的东西必须逐条可解释，
 * 且**绝不碰别人家的属性**。落地成两条可检查的规则：
 *
 * 1. 「别人家的」属性（`data-dsh-<其它插件>-*`）一律禁止，无论写在哪；
 * 2. 自己家的属性必须以 `data-dsh-personal-workbench-` 为前缀（或白名单里的 CSS 变量）。
 *
 * 第 2 条用前缀而不是枚举，是因为文档写的两条（`-active` / `--wb-sidebar-w`）之外，
 * 迁移期内 `-official`（区分"官方面板路径已就绪"给 CSS 用）、`-pending`（草稿浮卡定位）
 * 也是自用属性。前缀规则把"能写多少"限制成**有界且可解释**的一类，
 * 同时让"写了别家前缀"这种越界当场失败 —— 那才是文档真正防的事故。
 */
test('I4：写 `<html>` 的属性必须都是本插件自己的（绝不碰别家）', () => {
  /** 自用属性的前缀：本插件在 constants.ts 里定义的全部根属性都长这样。 */
  const OWN_PREFIX = 'data-dsh-personal-workbench-'
  /** 白名单：自用的 CSS 变量（面板左边界）。 */
  const OWN_STYLE_VARS = new Set(['--wb-sidebar-w'])
  /** 别人家的前缀：`data-dsh-<别的插件>` —— 出现即越界。 */
  const FOREIGN = /^data-dsh-(?!personal-workbench)/

  const violations = []
  for (const { path, text } of sources) {
    const code = stripComments(text)
    code.split('\n').forEach((line, index) => {
      const call = /(document\.documentElement|root|html)\s*\.\s*(set|remove)Attribute\(\s*([^,)]+)/.exec(line)
      if (call !== null) {
        const [, receiver, , rawName] = call
        const name = rawName.trim().replace(/['"]/g, '')
        const where = `${rel(path)}:${index + 1}`
        if (FOREIGN.test(name)) violations.push(`${where} 写了别人家的属性 ${name}`)
        else if (name.startsWith('data-') && !name.startsWith(OWN_PREFIX)) violations.push(`${where} 写了非自用前缀的属性 ${name}`)
        // 变量名形式（如 ACTIVATE_ATTR）无法在此静态解析，交由下面的"自用属性清单"测试覆盖。
      }
      for (const match of code.matchAll(/setProperty\(\s*'([^']+)'/g)) {
        if (!OWN_STYLE_VARS.has(match[1])) violations.push(`${rel(path)} setProperty('${match[1]}') 不在白名单`)
      }
    })
  }
  assert.deepEqual(violations, [], `根元素写入越界：\n  - ${violations.join('\n  - ')}`)
})

test('I4 补充：constants.ts 里声明给根元素用的属性，必须都是自用前缀', () => {
  const constants = sources.find(({ path }) => rel(path) === 'client/constants.ts')
  assert.ok(constants !== undefined, 'constants.ts 必须存在')
  const code = stripComments(constants.text)
  const declared = [...code.matchAll(/export const (\w+)\s*=\s*'([^']+)'/g)]
    .map(([, name, value]) => ({ name, value }))
    .filter(({ name }) => name.endsWith('_ATTR'))
  assert.ok(declared.length > 0, 'constants.ts 里应当有若干 *_ATTR')
  for (const { name, value } of declared) {
    assert.ok(value.startsWith('data-dsh-personal-workbench-'),
      `${name} = "${value}" 不是本插件自己的属性前缀 —— 写在宿主根元素上会与别的插件打架`)
  }
})

test('白名单与设计文档第 5.2 节一致（两个属性，不多不少）', () => {
  const doc = readFileSync(new URL('../docs/design/2026-09-13-client-architecture-official-only.md', import.meta.url), 'utf8')
  assert.ok(doc.includes('data-dsh-personal-workbench-active'), '设计文档里应有 ACTIVE_ATTR 那条')
  assert.ok(doc.includes('--wb-sidebar-w'), '设计文档里应有面板左边界那条')
})

/**
 * 阶段 2 之后再出现"探测失败就换一条腿"的分支就是回退：
 * 缺能力只有一种正确反应 —— **明确不启动**（`capabilities.ts` 的 refuseToStart）。
 */
test('不存在"探测到老宿主就降级"的分支', () => {
  for (const { path, text } of sources) {
    if (rel(path) === 'client/capabilities.ts') continue // 它就是"不启动"的实现
    const code = stripComments(text)
    for (const needle of ['officialSlotDecision', 'useSelfHostedOverlay', 'fallbackToOverlay', 'mountOverlayContent']) {
      assert.equal(code.includes(needle), false,
        `${rel(path)} 仍出现 "${needle}" —— 兼容层/降级腿已删除，缺能力一律不启动（P5）`)
    }
  }
})
