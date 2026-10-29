/**
 * 入口文案的语言（issue #12 的入口侧延伸）。
 *
 * 入口（侧栏面板行 + 会话标题栏按钮）渲染在 `I18nProvider` **之外**，所以它有自己的
 * 解析入口 `entryLocale.ts`。这里钉住三件会静默出错的事：
 * 1. 入口不许自己实现一遍 `auto` 的解析方向 —— 必须与面板内部同一个 `resolveLocale`；
 * 2. 未翻译的入口 key 原样回中文，不能变成空白（英文浏览器看到空按钮）；
 * 3. 入口文案在客户端源码里**只有一处中文原文**：侧栏注册与会话标题栏按钮
 *    必须共用 `entryText(ENTRY_TITLE_KEY)`，否则按 aria-label 找那一行会找不到
 *    （`officialPanelRowRendered` 的取值口径与注册必须一致）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertClientCount, read } from './_clientSources.mjs'
import {
  ENTRY_LOCALE_STORAGE_KEY, entryLocaleFor, entryTextFor,
} from '../lib/client/entryLocale.js'

const ENTRY_TITLE_ZH = '打开工作台（任务 / 日历 / 知识库 / 点子）'
const ENTRY_TITLE_EN = 'Open Workbench (tasks / calendar / knowledge / ideas)'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('入口语言与面板内部同一个解析：auto 跟浏览器，显式选择优先，脏值按 auto', () => {
  assert.equal(entryLocaleFor('auto', 'ru-RU'), 'en-US', '非中文浏览器 → 英文（issue #12 的需求来源）')
  assert.equal(entryLocaleFor('auto', 'zh-CN'), 'zh-CN')
  assert.equal(entryLocaleFor('auto', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(entryLocaleFor('auto', ''), 'zh-CN', '拿不到浏览器语言时保持旧行为（不会突然变英文）')
  assert.equal(entryLocaleFor('zh-CN', 'en-US'), 'zh-CN', '显式选择优先于浏览器')
  assert.equal(entryLocaleFor('en-US', 'zh-CN'), 'en-US', '显式选择优先于浏览器')
  assert.equal(entryLocaleFor('胡说', 'en-US'), 'en-US', '缓存里的脏值按 auto 处理，不按不存在的语言渲染')
})

test('入口文案：英文查表 / 中文原样 / 未收录回中文而不是空串', () => {
  assert.equal(entryTextFor('en-US', 'zh-CN', '工作台'), 'Workbench')
  assert.equal(entryTextFor('zh-CN', 'en-US', '工作台'), '工作台')
  assert.equal(entryTextFor('auto', 'ru-RU', ENTRY_TITLE_ZH), ENTRY_TITLE_EN)
  assert.equal(entryTextFor('auto', 'zh-CN', ENTRY_TITLE_ZH), ENTRY_TITLE_ZH)
  assert.equal(entryTextFor('auto', 'ru-RU', '收起工作台'), 'Close Workbench')
  assert.equal(entryTextFor('en-US', 'en-US', '没收录的入口文案 {n}', { n: 2 }), '没收录的入口文案 2', '缺参数时保留占位符')
})

test('入口缓存键不许改名（改名 = 用户之前选过的语言在下次装载时凭空失效）', () => {
  assert.equal(ENTRY_LOCALE_STORAGE_KEY, 'dsh-personal-workbench.entry-ui-locale')
})

test('入口文案只有一处中文原文：注册与标题栏共用同一个解析结果', () => {
  // 定义处恰好一处（`entryContract.ts`）；英文表在 src/shared，不算客户端的第二份。
  assertClientCount(assert, new RegExp(escapeRegExp(`'${ENTRY_TITLE_ZH}'`), 'g'), 1,
    '入口文案在客户端源码里只能定义一次')
  // 两个渲染点都必须是 entryText(ENTRY_TITLE_KEY)：侧栏注册 + 会话标题栏按钮的 title。
  assertClientCount(assert, /entryText\(ENTRY_TITLE_KEY\)/g, 2,
    '侧栏注册与会话标题栏必须都走 entryText(ENTRY_TITLE_KEY)')
  assert.ok(!read('src/client/index.tsx').includes(`'${ENTRY_TITLE_ZH}'`),
    'index.tsx 不许再内联这条文案（注册与查询各算一次就是 issue #12 的老坑）')
})

test('入口镜像只有两个写入点：装载设置后、保存设置后（权威源仍是服务端 meta）', () => {
  assertClientCount(assert, /cacheEntryUiLocale\(loaded\.uiLocale\)/g, 1,
    '装载设置后镜像一次')
  assertClientCount(assert, /cacheEntryUiLocale\(settings\.uiLocale\)/g, 1,
    '保存设置后镜像一次')
})
