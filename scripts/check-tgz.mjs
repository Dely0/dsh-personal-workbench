/**
 * 校验一个 tgz「装盘包」是否完好：能解出 package.json、版本号对得上、关键产物在。
 *
 * 为什么需要它（2026-09-13）：用户要求"把当前版本存档"。存档的前提是**这个包本身是好的** ——
 * 而本项目的 tgz 是靠内容指纹验证的，从来没有"打开包检查一遍"的步骤。
 * 一个字节损坏的 tarball 只有到 `dsh plugin add` 那一刻才会暴露，
 * 到那时用户可能已经重启过一次 DSH 了（代价很高）。
 *
 * 做法：零依赖读 gzip + tar 头（tar 格式足够简单，只需要前 512 字节的头部），
 * 不做完整解包，只核对：① gzip 能解；② tar 里能找到 package.json；③ 版本与期望一致；
 * ④ lib/client.js 与 lib/index.js 都在且非空。
 *
 * 用法：node scripts/check-tgz.mjs <tgz路径> [期望版本]
 */
import { createGunzip } from 'node:zlib'
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * ⚠️ tgz 路径**必须显式给**（2026-09-13 改）。
 *
 * 原先是 `process.argv[2] ?? 'dely0-dsh-personal-workbench-1.14.45.tgz'` ——
 * 一个写死的旧版本号默认值。它有两重坑：
 * 1. 忘了传参时会去校验一个跟当前版本无关的老包（甚至可能静默"通过"）；
 * 2. 整理归档后 tgz 已不在仓库根（历史包在 `_local-archive/tgz/`），
 *    那个默认值只会报"文件不存在"，把排查方向带偏。
 */
const tgz = process.argv[2]
if (tgz === undefined) {
  console.error('用法：node scripts/check-tgz.mjs <tgz路径> [期望版本]')
  console.error('  （tgz 由仓库根跑 `pnpm pack` 生成；历史包见 _local-archive/tgz/）')
  process.exit(2)
}
const expectedVersion = process.argv[3]

/** 把 gzip 流解成 Buffer（tar 是顺序格式，整份读进来最简单）。 */
async function gunzip(file) {
  const chunks = []
  await new Promise((resolve, reject) => {
    const gunzipStream = createGunzip()
    createReadStream(file)
      .pipe(gunzipStream)
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return Buffer.concat(chunks)
}

/** 逐条遍历 tar 头，收集文件条目（只读 512 字节头 + 跳过数据块）。 */
function listTarEntries(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    /** 全零块 = 归档结束 */
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText, 8) || 0
    const typeFlag = String.fromCharCode(header[156])
    entries.push({ name, size, typeFlag, dataOffset: offset + 512 })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

const problems = []
let buffer
try {
  buffer = await gunzip(tgz)
  console.log(`✅ gzip 解压成功（${statSync(tgz).size} 字节 → ${buffer.length} 字节 tar）`)
} catch (error) {
  console.error(`❌ gzip 解压失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const entries = listTarEntries(buffer)
console.log(`✅ tar 条目数：${entries.length}`)

/** ① package.json 必须能解析出版本号 */
const pkgEntry = entries.find((entry) => entry.name === 'package/package.json')
if (pkgEntry === undefined) {
  problems.push('包里没有 package/package.json')
} else {
  const text = buffer.subarray(pkgEntry.dataOffset, pkgEntry.dataOffset + pkgEntry.size).toString('utf8')
  try {
    const pkg = JSON.parse(text)
    console.log(`✅ package.json 可解析：${pkg.name}@${pkg.version}`)
    if (expectedVersion !== undefined && pkg.version !== expectedVersion) {
      problems.push(`版本不符：包内 ${pkg.version} ≠ 期望 ${expectedVersion}`)
    }
  } catch (error) {
    problems.push(`package.json 解析失败：${String(error)}`)
  }
}

/** ② 关键产物必须在且非空（这两个是插件的主体与客户端半边） */
for (const required of ['package/lib/client.js', 'package/lib/index.js']) {
  const entry = entries.find((item) => item.name === required)
  if (entry === undefined) problems.push(`缺少 ${required}`)
  else if (entry.size <= 0) problems.push(`${required} 是空文件`)
  else console.log(`✅ ${required}（${entry.size} 字节）`)
}

/** ③ 顺手确认 cordis.patch.yml 也打进去了（没有它插件不会被 loader 装上） */
if (entries.some((entry) => entry.name === 'package/cordis.patch.yml')) {
  console.log('✅ package/cordis.patch.yml 存在')
} else {
  problems.push('缺少 cordis.patch.yml（插件不会被 loader 装上）')
}

console.log(`\n包名：${basename(tgz)}`)
if (problems.length === 0) {
  console.log('✅ 存档包完好，可安全用于 dsh plugin add')
  process.exit(0)
}
console.log('❌ 存档包有问题：')
for (const problem of problems) console.log(`   - ${problem}`)
process.exit(1)
