import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function between(start, end) {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `Missing source anchors: ${start}`)
  return source.slice(a, b).replaceAll('(): void', '()')
}
const ensure = between('function ensureStyle(): void {', '\n/**')
const registration = between('  const styleObserver = ', '\n\n')
const cleanup = between('  const cleanup = (): void => {', '\n  // 注册给模块级守卫')

// Exercise the actual source fragments; unrelated host services are stubbed.
function fixture() {
  const observers = []
  const nodes = []
  let callbacks = 0
  const notify = () => {
    for (const observer of observers) {
      if (!observer.active || observer.pending) continue
      observer.pending = true
      queueMicrotask(() => {
        observer.pending = false
        if (observer.active) { callbacks++; observer.callback() }
      })
    }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this) }
    observe() { this.active = true }
    disconnect() { this.active = false }
  }
  const document = {
    querySelector: () => nodes[0] ?? null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: node => { nodes.push(node); notify() } },
    documentElement: { removeAttribute() {} },
  }
  function apply(css = 'current-css') {
    const stubs = `let disposed=false, instanceAlive=true, activeDisposer;
      const sidebarResizeObserver=undefined, sidebarCollapseObserver=undefined, sidebarObserver=undefined, titlebarAttributeObserver=undefined;
      const titlebarTimer=0, syncTopInset=()=>{}, officialDisposers=[], ACTIVE_ATTR='a', OFFICIAL_ATTR='b', getPluginCtx=()=>undefined, ctx={}, setPluginCtx=()=>{}, workbenchHost=undefined, runtime={};`
    return new Function('document', 'MutationObserver', 'CSS', 'window', `${ensure}\n${stubs}\nensureStyle();\n${registration}\n${cleanup}\nreturn { ensure:ensureStyle, cleanup };`)(document, Observer, css, { removeEventListener() {} })
  }
  return { apply, nodes, observers, notify, remove() { nodes.splice(0); notify() }, callbacks: () => callbacks }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('style recovery: repeated removal restores one node and callbacks settle', async () => {
  const f = fixture(), instance = f.apply()
  for (let i = 0; i < 20; i++) instance.ensure()
  for (let i = 0; i < 8; i++) { f.remove(); await settle(); assert.equal(f.nodes.length, 1) }
  assert.equal(f.nodes[0].textContent, 'current-css')
  assert.equal(f.observers.length, 1)
  const count = f.callbacks(); await settle(); assert.equal(f.callbacks(), count)
  instance.cleanup()
})
test('style recovery: cleanup disconnects and is idempotent', async () => {
  const f = fixture(), instance = f.apply()
  instance.cleanup(); instance.cleanup(); f.remove(); await settle()
  assert.equal(f.nodes.length, 0)
  assert.equal(f.observers.filter(o => o.active).length, 0)
})
test('style recovery: pending notifications cannot restore after cleanup', async () => {
  const f = fixture(), instance = f.apply()
  f.remove(); instance.cleanup(); await settle(); assert.equal(f.nodes.length, 0)
})
test('style recovery: reapply arms a fresh observer', async () => {
  const f = fixture(), first = f.apply()
  first.cleanup(); f.remove(); await settle()
  const second = f.apply(); f.remove(); await settle()
  assert.equal(f.nodes[0].textContent, 'current-css')
  assert.equal(f.observers.filter(o => o.active).length, 1)
  second.cleanup()
})
test('style recovery: disposed module cannot restore its old CSS', async () => {
  const f = fixture(), first = f.apply('old-css')
  first.cleanup()
  const second = f.apply('new-css')
  f.remove(); await settle()
  assert.equal(f.nodes[0].textContent, 'new-css')
  assert.equal(f.observers.filter(o => o.active).length, 1)
  second.cleanup()
})
test('style recovery: unrelated head changes do not duplicate CSS', async () => {
  const f = fixture(), instance = f.apply()
  f.notify(); await settle(); assert.equal(f.nodes.length, 1)
  instance.cleanup()
})
test('style recovery: previous instance cleanup precedes observer registration', () => {
  const apply = source.slice(source.indexOf('export function apply('))
  assert.ok(apply.indexOf('disposePreviousInstance()') < apply.indexOf('const styleObserver ='))
  assert.ok(cleanup.includes('styleObserver.disconnect()'))
})
