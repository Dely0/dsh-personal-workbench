import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWorkspacePath, windowsToWsl, wslToWindows } from '../lib/workspace-check.js'

/**
 * `src/workspace-check.ts` 单测（导入 `lib/` 编译产物，与既有测试同口径）。
 *
 * 覆盖的是"原始验收标准"里那条最容易静默失败的规则：用户填了个不存在/不是目录的
 * 工作区时，必须**明确报错**而不是悄悄回落默认值。所以这里断言的重点不是 `ok` 一个
 * 布尔，而是 `reason` 里那几句中文提示真的出现了。
 *
 * 确定性要求：
 * - "不存在"一律用 `randomUUID()` 拼随机目录名，绝不用 `Z:\...` 这类可能真存在的盘符；
 * - "存在但不可写"这类依赖权限位语义的用例在 Windows 上无法稳定构造，故不覆盖；
 * - 临时目录统一走 `rmTempDir()` 带重试清理（Windows 上 `rmSync` 会因句柄未释放偶发 EPERM，
 *   那是"清理期假失败"，与功能无关）。
 */

const isWindows = process.platform === 'win32'

/** 删临时目录，容忍 Windows 上杀毒/索引占用导致的 EPERM/EBUSY，重试 5 次后放弃（放弃不 fail）。 */
function rmTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error
      // 同步忙等一小会儿：测试进程里没有别的活可干，等一下最省事。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

/** 仓库根目录（本文件在 `test/` 下），用于"真实存在的文件"这类用例。 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 独立实现一份"Windows → WSL 形态"的映射，用来**反推** WSL 形态的输入，
 * 而不是调用被测的 `windowsToWsl()`——否则被测函数错了，用例会跟着一起错还照样绿。
 */
function toWslForm(winPath) {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath)
  assert.ok(m !== null, `前置条件失败：应为 Windows 盘符路径，实际收到 ${winPath}`)
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

test('workspace-check: 空路径视为"未指定"，ok 且 normalized/reason 均为 null', () => {
  for (const raw of ['', '   ', '\t', null, undefined]) {
    const result = checkWorkspacePath(raw)
    assert.equal(result.ok, true, `raw=${JSON.stringify(raw)} 应判为 ok（不填=用默认工作区，不算错误）`)
    assert.equal(result.normalized, null, `raw=${JSON.stringify(raw)} 的 normalized 应为 null`)
    assert.equal(result.reason, null, `raw=${JSON.stringify(raw)} 的 reason 应为 null`)
  }
})

test('workspace-check: 真实存在且可写的目录通过校验，normalized 指向真实目录', () => {
  const created = mkdtempSync(join(tmpdir(), 'dsh-wb-check-ok-'))
  try {
    // 1) os.tmpdir() 本身 + 2) 刚建出来的子目录 + 3) 两侧带空格的粘贴形态（应被 trim）
    for (const raw of [tmpdir(), created, `  ${created}  `]) {
      const result = checkWorkspacePath(raw)
      assert.equal(result.ok, true, `raw=${raw} 应通过校验，实际 reason=${result.reason}`)
      assert.ok(typeof result.normalized === 'string' && result.normalized.length > 0, 'normalized 应为非空字符串')
      assert.equal(result.reason, null)
      assert.equal(existsSync(result.normalized), true, `normalized 必须真实存在：${result.normalized}`)
      assert.equal(statSync(result.normalized).isDirectory(), true, 'normalized 必须是目录')
    }
  } finally {
    rmTempDir(created)
  }
})

test('workspace-check: 不存在的路径被拒绝，reason 说明"工作区目录不存在"', () => {
  // 随机 UUID 目录名：不依赖任何盘符是否存在，保证一定不存在。
  const ghost = join(tmpdir(), `dsh-wb-ghost-${randomUUID()}`)
  assert.equal(existsSync(ghost), false, `前置条件失败：随机目录竟然已存在 ${ghost}`)
  assert.equal(existsSync(join(ghost, 'nested', 'xyz')), false, '前置条件失败：多层随机路径竟然已存在')

  for (const raw of [ghost, join(ghost, 'nested', 'xyz')]) {
    const result = checkWorkspacePath(raw)
    assert.equal(result.ok, false, `raw=${raw} 不存在，必须判为不 ok（不能静默回落默认值）`)
    assert.equal(result.normalized, null, 'ok:false 时不应给出 normalized')
    assert.ok(result.reason?.includes('工作区目录不存在'), `reason 应含"工作区目录不存在"，实际=${result.reason}`)
  }
})

test('workspace-check: 存在的文件（不是目录）被拒绝，reason 说明"不是目录"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-file-'))
  const tempFile = join(dir, 'not-a-dir.txt')
  writeFileSync(tempFile, 'x')
  try {
    const targets = [join(projectRoot, 'package.json'), tempFile]
    for (const raw of targets) {
      assert.equal(existsSync(raw), true, `前置条件失败：${raw} 应真实存在`)
      const result = checkWorkspacePath(raw)
      assert.equal(result.ok, false, `raw=${raw} 是文件，必须判为不 ok`)
      assert.equal(result.normalized, null)
      assert.ok(result.reason?.includes('不是目录'), `reason 应含"不是目录"，实际=${result.reason}`)
    }
  } finally {
    rmTempDir(dir)
  }
})

test('workspace-check: WSL 形态 /mnt/<drive>/... 在 Windows 上映射回真实目录', { skip: !isWindows && '仅 Windows 平台有 WSL↔Windows 映射' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-wsl-'))
  try {
    const wslForm = toWslForm(dir)
    assert.match(wslForm, /^\/mnt\/[a-z]\//, `前置条件失败：WSL 形态应形如 /mnt/<drive>/...，实际 ${wslForm}`)

    const result = checkWorkspacePath(wslForm)
    assert.equal(result.ok, true, `WSL 形态 ${wslForm} 应映射成功，实际 reason=${result.reason}`)
    assert.ok(typeof result.normalized === 'string' && result.normalized.length > 0)
    assert.equal(existsSync(result.normalized), true, `normalized 必须真实存在：${result.normalized}`)
    assert.equal(statSync(result.normalized).isDirectory(), true)

    // 归一化结果应当就是那个真实目录（Windows 路径大小写不敏感，故按小写比对）。
    assert.equal(result.normalized.toLowerCase(), dir.toLowerCase())
    assert.equal(wslToWindows(wslForm).toLowerCase(), dir.toLowerCase())
  } finally {
    rmTempDir(dir)
  }
})

test('workspace-check: wslToWindows 纯字符串转换，非匹配输入原样返回', () => {
  // 非匹配输入：无论平台都必须一字不改地返回（在 Linux/WSL 上则连匹配输入也不动）。
  const nonMatching = ['D:\\Code', 'D:/Code', '/home/user/code', 'code', '', '/mnt/dd/code', 'mnt/d/code', 'D:']
  for (const raw of nonMatching) {
    assert.equal(wslToWindows(raw), raw, `非匹配输入应原样返回：${raw}`)
  }

  if (!isWindows) {
    // 非 win32：只在 Windows 上转换，其余平台必须原样返回，否则会把本来正确的路径改坏。
    for (const raw of ['/mnt/d/Code', '/mnt/c/Users/Me', '/mnt/d']) {
      assert.equal(wslToWindows(raw), raw, `非 win32 平台不应转换：${raw}`)
    }
    return
  }

  assert.equal(wslToWindows('/mnt/d/code'), 'D:\\code')
  assert.equal(wslToWindows('/mnt/d/code/sub'), 'D:\\code\\sub')
  assert.equal(wslToWindows('/mnt/c/Users/Me'), 'C:\\Users\\Me')
  assert.equal(wslToWindows('/mnt/D/Code'), 'D:\\Code', '盘符应大写、其余部分保留原大小写')
  assert.equal(wslToWindows('/mnt/d'), 'D:\\', '裸盘符应补成盘根')
  assert.equal(wslToWindows('/mnt/d/'), 'D:\\')
})

test('workspace-check: windowsToWsl 纯字符串转换，非匹配输入原样返回', () => {
  assert.equal(windowsToWsl('D:\\Code'), '/mnt/d/Code')
  assert.equal(windowsToWsl('D:/Code'), '/mnt/d/Code', '正斜杠形态同样应转换')
  assert.equal(windowsToWsl('d:\\myproject\\sub'), '/mnt/d/myproject/sub', '盘符应小写、其余部分保留原大小写')
  assert.equal(windowsToWsl('C:\\Users\\Me\\Project'), '/mnt/c/Users/Me/Project')

  // 非匹配：已经是 WSL 形态、相对路径、空串、没有分隔符的裸盘符，都应原样返回。
  for (const raw of ['/mnt/d/Code', '/home/user/code', 'Code', './Code', '../Code', '', 'D:', 'C:relative']) {
    assert.equal(windowsToWsl(raw), raw, `非匹配输入应原样返回：${raw}`)
  }
})

test('workspace-check: Windows 反斜杠真实路径（tmpdir 与项目根）通过校验', { skip: !isWindows && '仅 Windows 平台有反斜杠路径形态' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-win-'))
  try {
    assert.ok(dir.includes('\\'), `前置条件失败：应拿到反斜杠形态路径，实际 ${dir}`)

    for (const raw of [dir, projectRoot, dir.replace(/\\/g, '/')]) {
      const result = checkWorkspacePath(raw)
      assert.equal(result.ok, true, `raw=${raw} 应通过校验，实际 reason=${result.reason}`)
      assert.ok(typeof result.normalized === 'string' && result.normalized.length > 0)
      assert.equal(existsSync(result.normalized), true, `normalized 必须真实存在：${result.normalized}`)
      assert.equal(statSync(result.normalized).isDirectory(), true)
      // 输入本身就能命中（归一化只在"原样探测不到"时才换形态），故 normalized 应与输入同指一处。
      assert.equal(result.normalized.toLowerCase(), raw.toLowerCase())
    }
  } finally {
    rmTempDir(dir)
  }
})
