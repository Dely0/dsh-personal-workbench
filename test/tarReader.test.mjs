/**
 * AX-R08（包资产部分）：**tar 读取器必须认 PAX 扩展头**。
 *
 * ## 为什么值得单独一条测试（2026-10-01 实测抓到的真 bug）
 *
 * **现象**：`pnpm pack` 出来的 tgz 里明明有 `assets/personas/**.md`，
 * `node scripts/check-tgz.mjs` 却报"包里没有内置角色库"。
 *
 * **原因**：`pnpm pack` 对**非 ASCII 文件名**（中文角色名 / 中文截图名）一律写
 * **PAX 扩展头**（`typeflag='x'`，真路径在数据里 `NN path=<真路径>\n`），
 * 经典头里放的是**字面量 `PaxHeader`**（长路径还会被截断到 100 字节）。
 * 旧读取器不认 PAX → 那些条目**既列不出来也匹配不到**：报的是"没有"，
 * 而不是"我没看懂"。更隐蔽的是另一种后果：**以为检查过了，其实根本没看那个文件**
 * （静默漏检）。
 *
 * `npm pack` 对中文名写经典头，所以本地换 npm 打包时一切正常 —— 这类"换个工具就消失"
 * 的 bug 只能靠**判据**钉住，不能靠记得。
 *
 * 判据用手搓的 tar 缓冲（PAX 头 + 被截断的经典头），不依赖任何打包器行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listTarEntries, readEntryContent } from '../scripts/lib/tarReader.mjs'

/** 造一个 512 字节的 tar 头（只填我们读的三个字段）。 */
function header(name, { size = 0, typeFlag = '0' } = {}) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(size.toString(8).padStart(11, '0'), 124, 12, 'utf8')
  block.write(typeFlag, 156, 1, 'utf8')
  return block
}

/** 造一块内容（补齐到 512 的整数倍）。 */
function data(text) {
  const raw = Buffer.from(text, 'utf8')
  const padded = Buffer.alloc(Math.ceil(raw.length / 512) * 512)
  raw.copy(padded)
  return padded
}

/** PAX 扩展头的数据格式：`<长度> path=<值>\n`（长度含自身）。 */
function paxPath(value) {
  const body = ` path=${value}\n`
  const length = Buffer.byteLength(body) + 2
  return `${length}${body}`
}

test('tarReader：经典头（短路径）照常读出', () => {
  const tar = Buffer.concat([header('package/package.json', { size: 7 }), data('{"a":1}'), Buffer.alloc(1024)])
  const entries = listTarEntries(tar)
  assert.deepEqual(entries.map((entry) => entry.name), ['package/package.json'])
  assert.equal(readEntryContent(tar, entries[0]).toString('utf8'), '{"a":1}')
})

test('tarReader：PAX 扩展头覆盖经典头里的占位名（pnpm pack 的真实形态）', () => {
  const realPath = 'package/assets/personas/engineering/只读审查者.md'
  /** 实测：`pnpm pack` 对**非 ASCII 文件名**一律写 PAX 头，经典头里放的是字面量 `PaxHeader`。 */
  const pax = paxPath(realPath)
  const tar = Buffer.concat([
    header('PaxHeader', { size: Buffer.byteLength(pax), typeFlag: 'x' }),
    data(pax),
    header('PaxHeader', { size: 5 }),
    data('hello'),
    Buffer.alloc(1024),
  ])
  const entries = listTarEntries(tar)
  assert.deepEqual(entries.map((entry) => entry.name), [realPath], '必须用 PAX 里的真实路径，而不是 `PaxHeader` 这个占位名')
  assert.equal(readEntryContent(tar, entries[0]).toString('utf8'), 'hello', 'PAX 头本身不能被当成一个文件条目')
})

test('tarReader：经典头里被截断的长路径同样由 PAX 纠正（>100 字节的情形）', () => {
  const longPath = `package/${'深'.repeat(40)}/只读审查者.md`
  assert.equal(Buffer.byteLength(longPath, 'utf8') > 100, true, '这条判据必须真的超过 100 字节，否则测不到截断')
  const pax = paxPath(longPath)
  const tar = Buffer.concat([
    header(longPath.slice(0, 60), { size: Buffer.byteLength(pax), typeFlag: 'x' }),
    data(pax),
    header(longPath.slice(0, 60), { size: 2 }),
    data('ok'),
    Buffer.alloc(1024),
  ])
  assert.deepEqual(listTarEntries(tar).map((entry) => entry.name), [longPath])
})

test('tarReader：全局 PAX 头（typeflag=g）不改下一条的名字，也不产出条目', () => {
  const pax = paxPath('package/whatever.md')
  const tar = Buffer.concat([
    header('pax_global_header', { size: Buffer.byteLength(pax), typeFlag: 'g' }),
    data(pax),
    header('package/short.md', { size: 2 }),
    data('ok'),
    Buffer.alloc(1024),
  ])
  const entries = listTarEntries(tar)
  assert.deepEqual(entries.map((entry) => entry.name), ['package/short.md'])
})

test('tarReader：多个长路径条目的 PAX 路径不串味', () => {
  const a = 'package/assets/personas/engineering/反向验证者.md'
  const b = 'package/assets/personas/quality/测试工程师.md'
  const build = (paxTarget, real, content) => [
    header(paxTarget.slice(0, 40), { size: Buffer.byteLength(paxPath(real)), typeFlag: 'x' }),
    data(paxPath(real)),
    header(paxTarget.slice(0, 40), { size: Buffer.byteLength(content) }),
    data(content),
  ]
  const tar = Buffer.concat([...build(a, a, 'AAA'), ...build(b, b, 'BB'), Buffer.alloc(1024)])
  const entries = listTarEntries(tar)
  assert.deepEqual(entries.map((entry) => entry.name), [a, b])
  assert.deepEqual(entries.map((entry) => readEntryContent(tar, entry).toString('utf8')), ['AAA', 'BB'])
})

test('tarReader：全零块终止解析（后面的垃圾不被当条目）', () => {
  const tar = Buffer.concat([header('package/a.md', { size: 1 }), data('x'), Buffer.alloc(1024), header('package/ghost.md', { size: 1 }), data('y')])
  assert.deepEqual(listTarEntries(tar).map((entry) => entry.name), ['package/a.md'])
})
