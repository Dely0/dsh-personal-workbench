/**
 * D17 源码扫描测试的**共享底座**。
 *
 * 为什么需要它：拆分前大量接线判据写的是 `readFileSync('src/client/index.tsx')`。
 * D17 把职责按域搬进 `hooks/` 与 `views/` 之后，这些断言会**因为实现搬家而假红**
 * （看着像"接线断了"，其实只是文件换了）—— 本仓 skill §14 的记录里这类假红出现过多次。
 *
 * 设计文档 §8 对这类判据的要求是：
 * 1) 正向接线测试读**真实 owner**（实现搬到哪，判据就指哪）；
 * 2) 负向唯一性必须**递归覆盖相关客户端源码**，不能只在旧入口里查"没有第二份"。
 *
 * 本文件就提供这两件事。**它不是"放宽判据"**：唯一性断言改成"整个 client 目录里恰好 N 处"
 * 比原来的"index.tsx 里恰好 N 处"更强（搬家后 index 里当然没了，光看 index 会空洞通过）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读一个相对仓库根的文件（行尾归一成 `\n`，避免 Windows 检出的 CRLF 让正则匹配不到）。 */
export function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n')
}

/** 去掉注释，避免"注释里提到某个写法"被当成代码里的第二处实现。 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
}

/**
 * 递归收集 `src/client/` 下所有 `.ts` / `.tsx`（相对仓库根的路径 + 正文）。
 * 返回顺序稳定（按路径排序），断言失败时输出可比对。
 */
export function readClientSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      out.push({
        path: join(ROOT, full),
        rel: relative(ROOT, full).replace(/\\/g, '/'),
        text: readFileSync(full, 'utf8').replace(/\r\n/g, '\n'),
      })
    }
  }
  walk(join(ROOT, 'src/client'))
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** 在全部客户端源码（剥注释后）里统计某个模式的出现总次数。 */
export function countInClient(pattern) {
  let total = 0
  const hits = []
  for (const file of readClientSources()) {
    const n = (stripComments(file.text).match(pattern) ?? []).length
    if (n > 0) { total += n; hits.push(`${file.rel}×${n}`) }
  }
  return { total, hits }
}

/**
 * 断言某个写法在整个客户端源码里**恰好出现 n 次**（剥注释后）。
 *
 * 失败信息会把命中分布带上 —— 否则只看到一个数字，排查时还得自己再扫一遍。
 */
export function assertClientCount(assert, pattern, n, message) {
  const { total, hits } = countInClient(pattern)
  assert.equal(total, n, `${message}（全客户端 ${total} 处：${hits.join('、') || '无'}）`)
}
