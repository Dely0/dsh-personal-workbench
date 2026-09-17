/**
 * 反向验证：把「知识草稿静默覆盖」的修复**装回去**，断言必须变红。
 *
 * ## 为什么必须有它
 *
 * 这次修复有一半是**接线**（工具把"被替换的标题"读出来、历史真的写进 payload、
 * 弹窗真的把提示渲染出来），另一半是**措辞**。只测纯函数全绿说明不了什么：
 * 把 `withKnowledgeDraftHistory` 从调用点摘掉，纯函数照样全绿，而界面又变回
 * "长得跟新建一样" —— 那正是本次要修的缺陷本身。
 *
 * 每条变异跑完立刻从内存还原原文件（`finally`），工作区不留改动。
 * 任何一条变异"照样全绿"就以非零码退出。
 *
 * 用法：node scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE = join(ROOT, 'lib', 'shared', 'knowledgeDraftOverwrite.js')
const TOOLS = join(ROOT, 'src', 'tools.ts')
/**
 * 编译产物：`test/tools.test.mjs` 跑的是**真实工具**（`lib/tools.js`），
 * 所以"行为级"变异要打在它上面；只改 `src/` 只能被源码扫描断言看见。
 */
const LIB_TOOLS = join(ROOT, 'lib', 'tools.js')
const INDEX = join(ROOT, 'src', 'index.ts')
const BANNER = join(ROOT, 'src', 'client', 'components', 'DraftBanner.tsx')
const BODY = join(ROOT, 'src', 'client', 'components', 'KnowledgeDraftBody.tsx')
const TEST_FILES = ['test/knowledgeDraftOverwrite.test.mjs', 'test/tools.test.mjs']

/**
 * 每条变异：{ name, file, from（正则）, to, expect（守的是什么，仅用于展示） }
 *
 * ⚠️ 纯判定变异打在 `lib/` 里编译后的 `.js`（单测 import 的就是它）；
 * 接线变异打在 `src/`（接线断言读的就是源码）。
 */
const MUTATIONS = [
  {
    name: 'M1 覆盖不再被识别：本会话已有草稿也判成 created（回到"静默"的原形态）',
    file: MODULE,
    from: /return \{\n\s*mode: 'replaced-session-draft',/,
    to: "return {\n        mode: 'created',",
    expect: '不带 draft_id 命中已有草稿必须判成 replaced-session-draft',
  },
  {
    name: 'M2 revision 不再递增（界面就永远说不出"第 N 次"）',
    file: MODULE,
    from: /const revision = history\.revision \+ 1;/,
    to: 'const revision = history.revision;',
    expect: 'revision 必须跟着写入次数累加',
  },
  {
    name: 'M3 被替换的标题不再入列（回执/界面说不出"没了什么"）',
    file: MODULE,
    from: /replacedTitles: \[\.\.\.history\.replacedTitles, \.\.\.\(replacedTitle === null \? \[\] : \[replacedTitle\]\)\]/,
    to: 'replacedTitles: history.replacedTitles,',
    expect: '被覆盖的标题要按时间先后记进历史',
  },
  {
    name: 'M4 覆盖那条回执改回"已保存"（读起来像新建 = 缺陷本体）',
    file: MODULE,
    from: /return `⚠️ 已更新本会话已有草稿（id=\$\{draftId\}）——不是新建：/,
    to: 'return `知识草稿已保存（id=${draftId}）：',
    expect: '覆盖回执必须写明"已更新本会话已有草稿 / 不是新建"',
  },
  {
    name: 'M5 界面提示恒为 null（用户点确认前又看不见了）',
    file: MODULE,
    from: /if \(history\.replacedTitles\.length === 0 && history\.revision <= 1\)\n        return null;/,
    to: 'if (true)\n        return null;',
    expect: '被覆盖过的草稿要在界面上给出提示',
  },
  {
    name: 'M6 界面提示不带草稿 id（用户/模型对不上"哪一份"）',
    file: MODULE,
    from: /（草稿 id \$\{draftId\}）。/,
    to: '。',
    expect: '提示必须带草稿 id',
  },
  {
    name: 'M7 提示里丢掉"一个会话只产出多条要走哪条路"（约束又查不到了）',
    file: MODULE,
    from: /'要在一个会话里产出多条知识，请走 POST \/api\/workbench\/drafts。';/,
    to: "'';",
    expect: '界面提示也要指路 POST /api/workbench/drafts',
  },
  {
    name: 'M8 工具写 payload 时丢掉历史（纯函数全绿、界面看不到任何东西）',
    file: TOOLS,
    from: /withKnowledgeDraftHistory\(payload, plan\)/,
    to: 'payload',
    expect: '写入必须带上 revision/replacedTitles',
  },
  {
    name: 'M9 不去读旧标题（回执只能笼统说"更新了"，说不出被替换的是哪条）',
    file: TOOLS,
    from: /const previousTitle = existing === undefined \? null : str\(\(existing\.payload as Record<string, unknown>\)\.title\) \?\? null/,
    to: 'const previousTitle = null',
    expect: '被替换的标题必须在 updateDraft 之前读出来',
  },
  {
    name: 'M9b 读的标题来源错了：拿**更新后**的新标题当"被替换的标题"（形态扫描满意、行为照旧）',
    file: LIB_TOOLS,
    from: /const previousTitle = existing === undefined \? null : str\(existing\.payload\.title\) \?\? null;/,
    to: 'const previousTitle = existing === undefined ? null : str(payload.title) ?? null;',
    expect: '被替换的标题必须来自旧草稿，而不是本次要写入的新内容',
  },
  {
    name: 'M10 工具改回只用一句"已保存"（回到旧措辞）',
    file: TOOLS,
    from: /return knowledgeDraftWriteMessage\(plan, draftIdOut\)/,
    to: 'return `知识草稿已保存（id=${draftIdOut}），等待用户在工作台确认后入库。请勿声称已存入知识库。`',
    expect: '回执必须由唯一实现按模式生成',
  },
  {
    name: 'M11 工具说明不再复用那份约束口径（帮助文案查不到"一个会话只产出 1 条"）',
    file: TOOLS,
    from: /\$\{KNOWLEDGE_DRAFT_SESSION_CONSTRAINT\}/,
    to: '',
    expect: '工具说明必须复用唯一口径',
  },
  {
    name: 'M12 常驻引导不再提"一个会话只产生 1 条知识草稿"（帮助文案缺一半）',
    file: INDEX,
    from: /一个会话只产生 1 条知识草稿/,
    to: '重复提交会更新草稿',
    expect: 'KNOWLEDGE_GUIDE 要写明一个会话只产生 1 条',
  },
  {
    name: 'M13 常驻引导不再指绕行路由（要多条的人不知道去哪）',
    file: INDEX,
    from: /走 POST \/api\/workbench\/drafts。/,
    to: '自行分批处理。',
    expect: 'KNOWLEDGE_GUIDE 要指 POST /api/workbench/drafts',
  },
  {
    name: 'M14 弹窗不再把草稿 id 传给正文（提示里就说不出是哪一份）',
    file: BANNER,
    from: /body: <KnowledgeDraftBody draftId=\{draft\.id\} payload=\{payload\} \/>/,
    to: 'body: <KnowledgeDraftBody draftId="" payload={payload} />',
    expect: 'DraftBanner 必须把草稿 id 传进正文',
  },
  {
    name: 'M15 正文组件不再渲染覆盖提示（抽了组件却没接上）',
    file: BODY,
    from: /const notice = knowledgeDraftOverwriteNotice\(payload, draftId\)/,
    to: 'const notice = null',
    expect: 'KnowledgeDraftBody 必须真的调用提示生成',
  },
  {
    name: 'M16 内容完全相同也判成"被覆盖"（重复提交时给出假的丢件告警）',
    file: MODULE,
    from: /if \(input\.draftIdProvided === undefined && sameKnowledgeDraftContent\(input\.existing\.payload, input\.nextContent\)\) \{/,
    to: 'if (false) {',
    expect: '重复提交相同内容必须单独成一类（unchanged），不得虚报覆盖',
  },
  {
    name: 'M17 unchanged 判据太宽：不比正文（只要标题一样就说"内容没变"）',
    file: MODULE,
    from: /\n        && String\(record\.contentMd \?\? ''\) === next\.contentMd/,
    to: '',
    expect: '正文换了就必须仍算覆盖',
  },
  {
    name: 'M18 unchanged 判据把历史字段也算进去（首次覆盖后永远判"变了"）',
    file: MODULE,
    from: /return String\(record\.title \?\? ''\)\.trim\(\) === next\.title\.trim\(\)/,
    to: "if (record.revision !== 1) return false;\n    return String(record.title ?? '').trim() === next.title.trim()",
    expect: '比较只允许看内容字段，不允许看 revision/replacedTitles 这类历史字段',
  },
]

const run = () => spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: ROOT, encoding: 'utf8' })

/** 基线：未变异时必须全绿，否则后面的"变红"没有意义。 */
const baseline = run()
if (baseline.status !== 0) {
  console.error('基线就没过 —— 先修好单测再跑反向验证：')
  console.error(baseline.stdout)
  process.exit(2)
}
console.log(`基线：${TEST_FILES.join(' + ')} 全绿\n`)

let failures = 0
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  if (!mutation.from.test(original)) {
    console.error(`✖ ${mutation.name}\n    变异点没匹配上（源码结构变了，需要同步本探针）`)
    failures += 1
    continue
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))
    const result = run()
    const firstFail = (result.stdout.match(/✖ ([^\n]*)/g) ?? [])[0]?.trim() ?? '(无失败行)'
    if (result.status === 0) {
      console.error(`✖ ${mutation.name}\n    装回缺陷后仍然全绿 → 这条修复没有任何断言在守（期望守的是：${mutation.expect}）`)
      failures += 1
    } else {
      console.log(`✔ ${mutation.name}\n    变红：${firstFail}`)
    }
  } finally {
    writeFileSync(mutation.file, original)
  }
}

// 收尾自检：还原后必须还能全绿（防止探针把工作区改坏）
const restored = run()
if (restored.status !== 0) {
  console.error('还原后单测反而红了 —— 探针没把文件还原干净')
  process.exit(2)
}

if (failures > 0) {
  console.error(`\n❌ ${failures}/${MUTATIONS.length} 条变异没有被断言发现`)
  process.exit(1)
}
console.log(`\n✅ ${MUTATIONS.length}/${MUTATIONS.length} 条变异都被断言抓到（还原后仍全绿）`)
