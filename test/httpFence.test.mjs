/**
 * 源码级不变量：**请求围栏只有一份实现**（v1.15.1，调研文档 3.5 / 执行清单第 7 项）。
 *
 * ## 为什么要用"扫描"来证明
 *
 * `isLoopbackRequest` / `writeJson` / `readJsonBody` 原先在四处各有一份**逐字相同**的副本
 * （`dictionaryRoute.ts` / `localDirRoute.ts` / `openFileRoute.ts` / `routes/helpers.ts`）。
 * 当时它们还没漂移 —— 但"多份同一语义"正是本项目最大的 bug 类别（第 0 节）：
 * 只要有人给其中一处加一条安全头或改一次 origin 判定，另外三处就悄悄落后，**且没有任何测试会红**。
 *
 * "不存在第二处实现"**只能用扫描证明**（行为测试没法证明"别处没有"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { collect(full, out); continue }
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const FILES = collect(SRC).map((path) => ({ path: relative(SRC, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }))

test('httpFence: 围栏的**唯一实现**在 src/api/http.ts', () => {
  const owners = FILES
    .filter((file) => /export (async )?function (isLoopbackRequest|writeJson|readJsonBody)/.test(file.text))
    .map((file) => file.path)
  assert.deepEqual(owners, ['api/http.ts'], `围栏只允许在 api/http.ts 里实现，实际：${owners.join('、')}`)
})

test('httpFence: 响应头只有一处定义，且带 no-store / nosniff / no-referrer', () => {
  const headerOwners = FILES.filter((file) => file.text.includes('x-content-type-options')).map((file) => file.path)
  assert.deepEqual(headerOwners, ['api/http.ts'], `安全头只允许在 api/http.ts 里写，实际：${headerOwners.join('、')}`)
  const http = FILES.find((file) => file.path === 'api/http.ts').text
  assert.match(http, /cache-control': 'no-store'/, '用户私有数据不能被缓存')
  assert.match(http, /x-content-type-options': 'nosniff'/, '禁止浏览器按内容猜 MIME')
  assert.match(http, /referrer-policy': 'no-referrer'/, '原有头必须保留')
  assert.match(http, /content-type': 'application\/json; charset=utf-8'/)
})

test('httpFence: 其余模块只允许**再导出**，不许自己再写一份', () => {
  for (const path of ['api/dictionaryRoute.ts', 'api/localDirRoute.ts', 'api/openFileRoute.ts', 'api/routes/helpers.ts']) {
    const text = FILES.find((file) => file.path === path).text
    assert.match(text, /from '\.\.?\/http\.js'|re-export|再导出|从 http\.ts/, `${path} 应当从 api/http.ts 引入围栏`)
    assert.equal(/res\.writeHead\(/.test(text), false, `${path} 不许自己写响应头`)
    assert.equal(/socket\.remoteAddress/.test(text), false, `${path} 不许自己再做 loopback 判定`)
  }
})

test('httpFence: readJsonBody 的体积上限是"读的过程中"拦截（不是读完再判）', () => {
  const http = FILES.find((file) => file.path === 'api/http.ts').text
  assert.match(http, /if \(size > maxBytes\) return undefined/, '必须在流式读取途中就停下，避免先落一整份超大 body 在内存里')
})

test('httpFence: 快速录入文档解析的护栏常量都在服务端一处（客户端只共享 shared/）', () => {
  const server = FILES.find((file) => file.path === 'api/routes/quick-attachments.ts').text
  // 只数**调用点**（注释里也提到这个名字，不能拿文本出现次数当判据）
  assert.match(server, /inflateRawSync\([^)]*maxOutputLength/, 'DOCX 解压必须带 maxOutputLength')
  assert.match(server, /inflateSync\([^)]*maxOutputLength/, 'PDF 解压必须带 maxOutputLength')
  assert.equal((server.match(/, \{ maxOutputLength:/g) ?? []).length, 2, '两处 inflate 都要有；少一处就是解压炸弹')
  assert.match(server, /声明 .*字节，上限/, '解压前要按声明值拦')
  /**
   * 解压时/解压后两条路径的中文文案。
   *
   * ⚠️ 这条断言被 fresh-eyes 审查的 F3 修复更新过：超限文案从
   * `实际 N 字节，上限 M 字节` 改成了 `实际超过 N 字节上限`（由 `tooLargeMessage` 统一产出），
   * 于是"超限走的是 maxOutputLength"可以用**文案**区分，而不必把 zlib 的
   * `ERR_BUFFER_TOO_LARGE` 抛给中文界面。判据同步更新，否则它会变成一条假的红。
   */
  assert.match(server, /实际超过 .*字节上限/, '解压超限要有一条中文原因（不许回 zlib 英文原文）')
  assert.match(server, /function tooLargeMessage/, '超限文案只能有一处产出（避免两处各写一句、慢慢漂移）')
  assert.equal((server.match(/tooLargeMessage\(/g) ?? []).length, 3, 'tooLargeMessage 应有 1 处定义 + 2 处调用（解压时 / 解压后）')
  assert.match(server, /Cannot create a Buffer/, '要认得 zlib 的英文原文才翻译得了它（只用于识别，不外泄）')
  assert.match(server, /isInflateTooLargeError\(error\)/, 'DOCX 路径必须把 zlib 超限错误翻译过来')
  // 反向：不许出现"没有 maxOutputLength 的 inflate 调用"
  assert.equal(/inflate(?:Raw)?Sync\([^,)]*\)/.test(server), false, '存在不带选项的 inflate 调用 —— 那正是 fork 的写法')
  const shared = FILES.find((file) => file.path === 'shared/quickAttachments.ts').text
  assert.match(shared, /MAX_QUICK_ATTACHMENT_BYTES = 5 \* 1024 \* 1024/)
  // 客户端不许从服务端路由 import（会把 node:zlib 拉进浏览器 bundle）
  const client = FILES.find((file) => file.path === 'client/quickAttachments.ts').text
  assert.equal(/from '\.\.\/api\//.test(client), false, '客户端不能 import 服务端路由模块')
})
