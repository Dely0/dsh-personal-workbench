/**
 * **tar 读取器**（零依赖，只做"列条目 + 取条目内容"）。
 *
 * 为什么单独成模块：它是 `scripts/check-tgz.mjs` 的核心判定部件，而它的关键行为
 * （认 PAX 扩展头）**必须可测** —— 原来它内联在脚本里，于是有一个静默 bug 活了很久：
 *
 * > **现象**：`pnpm pack` 出来的 tgz 里明明有 `assets/personas/**.md`，
 * > `node scripts/check-tgz.mjs` 却说"包里没有内置角色库"。
 * >
 * > **原因**：`pnpm pack` 对**非 ASCII 文件名**（中文角色名、中文截图名）一律写
 * > **PAX 扩展头**（`typeflag='x'`，真路径在数据里 `NN path=<真路径>\n`），
 * > 经典头里放的是**字面量 `PaxHeader`**（长路径还会被截断到 100 字节）。
 * > 旧读取器不认 PAX，于是那些条目**既列不出来也匹配不到** ——
 * > 判定"已经检查过了"其实是**没看**。
 * >
 * > **判据**：`test/tarReader.test.mjs` 用手搓的 PAX + 截断头断言读到的路径是完整的。
 * >
 * > 顺带记录：这个 bug 也解释了"为什么 `screenshot/` 目录从来没进过包"——
 * > 同样的静默漏条目（`package/screenshot/今日任务.PNG` 是长路径）。
 */

/**
 * tar 归档里的一个条目。
 *
 * @typedef {{ name: string, size: number, typeFlag: string, dataOffset: number }} TarEntry
 * `dataOffset` 指向**数据**起点（= 头之后 512 字节）。
 */

/** 读一个 512 字节头里的八进制数字段。 */
function readOctal(header, start, length) {
  const text = header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim()
  return Number.parseInt(text, 8) || 0
}

/**
 * 逐条遍历 tar 头（只读头 + 跳过数据块，不解包）。
 *
 * 支持的**全部**情形：
 * - 经典头（`name` 在头里，≤100 字节）；
 * - PAX 扩展头（`typeflag='x'`）：`path=` 覆盖下一条的路径；
 * - 全局 PAX 头（`typeflag='g'`）：跳过，不改下一条的名字（它只放全局键值）；
 * - 归档结束块（全零）。
 *
 * @param {Buffer} buffer
 * @returns {TarEntry[]}
 */
export function listTarEntries(buffer) {
  /** @type {TarEntry[]} */
  const entries = []
  let offset = 0
  /** 紧邻的上一个 PAX 扩展头声明的真实路径。 */
  let pendingPath
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = readOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156])
    const dataOffset = offset + 512
    if (typeFlag === 'x' || typeFlag === 'g') {
      if (typeFlag === 'x') {
        const payload = buffer.subarray(dataOffset, dataOffset + size).toString('utf8')
        const match = /(?:^|\n)\d+ path=([^\n]*)\n?/.exec(payload)
        if (match !== null) pendingPath = match[1]
      }
      offset += 512 + Math.ceil(size / 512) * 512
      continue
    }
    entries.push({ name: pendingPath ?? name, size, typeFlag, dataOffset })
    pendingPath = undefined
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/**
 * 取某个条目的内容（按 `dataOffset` + `size` 切）。
 *
 * @param {Buffer} buffer
 * @param {TarEntry} entry
 * @returns {Buffer}
 */
export function readEntryContent(buffer, entry) {
  return buffer.subarray(entry.dataOffset, entry.dataOffset + entry.size)
}
