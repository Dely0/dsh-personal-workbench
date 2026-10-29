/**
 * Вкладка「点子」：语言层的回归.
 *
 * Смысл этих двух判据 (а не «перевести всё до последней буквы»):
 * 1. **Каждый обёрнутый литерал имеет словарную статью.** Без этого `t()` молча
 *    возвращает китайский ключ — вкладка выглядит «половинчато переведённой», и это
 *    не падает ни в каком другом тесте.
 * 2. **В UI-текстах трёх файлов вкладки не остаётся необёрнутых китайских литералов.**
 *    Данные (названия папок / заголовки точек / имена записей словаря из БД) сюда не
 *    попадают: они не переводятся по определению, поэтому считаем только литералы.
 *
 * Тест намеренно про ратчет: он не «разрешает добавлять китайский», а фиксирует, что зона
 * уже мигрирована, и новый китайский литерал в этих файлах провалит проверку.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'
import { EN_MESSAGES } from '../lib/shared/i18n.js'

const FILES = [
  'src/client/views/IdeasListView.tsx',
  'src/client/views/IdeasDetailPane.tsx',
  'src/client/components/IdeaCardGrid.tsx',
]
const CJK = /[\u4e00-\u9fff]/
const WRAPPED_BEFORE = /(?:\b|\.)(t|translate|entryText|entryTextFor|formatCount|interpolate)\($/

function decode(raw) {
  return raw.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c))
}

/** Собирает из файла все китайские литералы: строковые (и шаблонные без `${}`) + JSX-текст между тегами. */
function literals(source) {
  const out = []
  for (const line of stripComments(source).split('\n')) {
    const quoted = /(['"`])((?:[^'"`\\\n]|\\.)*)\1/g
    let m
    while ((m = quoted.exec(line)) !== null) {
      if (m[1] === '`' && m[2].includes('${')) continue
      if (!CJK.test(m[2])) continue
      out.push({ key: decode(m[2]), before: line.slice(0, m.index) })
    }
    for (const jsx of line.match(/>[^<>{}'"]*[\u4e00-\u9fff][^<>{}'"]*</g) ?? []) {
      out.push({ key: jsx.slice(1, -1).trim(), before: '' })
    }
  }
  return out
}

test('点子-вкладка: каждый t() с китайским ключом имеет статью в EN_MESSAGES', () => {
  const missing = []
  for (const file of FILES) {
    const source = read(file)
    for (const m of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = decode(m[1])
      if (!CJK.test(key)) continue
      if (!(key in EN_MESSAGES)) missing.push(`${file} → ${key}`)
    }
  }
  assert.deepEqual(missing, [], `нет словарных статей (${missing.length}): ${missing.join(' | ')}`)
})

test('点子-вкладка: в UI-литералах этих трёх файлов не осталось необёрнутого китайского', () => {
  const unwrapped = []
  for (const file of FILES) {
    for (const item of literals(read(file))) {
      if (WRAPPED_BEFORE.test(item.before)) continue
      // Одиночные полноширинные знаки пунктуации как разделители — не «непереведённая строка».
      if (!/[a-zA-Z\u4e00-\u9fff]{2,}/.test(item.key)) continue
      unwrapped.push(`${file} → ${item.key.slice(0, 60)}`)
    }
  }
  assert.deepEqual(unwrapped, [], `необёрнутых литералов: ${unwrapped.length}\n${unwrapped.join('\n')}`)
})

test('点子-вкладка: словарь не разъезжается по терминам (关联 = link, 归类 = file)', () => {
  // Эти три подписи рендерятся рядом на одном экране: «记个点子» (кнопка), «归入文件夹 …» (вход на
  // карточке), «未归类» (вкладка). Если их перевести разными словами, вкладка начнёт
  // противоречить сама себе — это ровно тот случай, который не ловит ни один визуальный тест.
  assert.equal(EN_MESSAGES['记个点子'], 'Capture an idea')
  assert.equal(EN_MESSAGES['未归类'], 'Unfiled')
  assert.equal(EN_MESSAGES['未归类（{n}）'], 'Unfiled ({n})')
  assert.match(EN_MESSAGES['归入文件夹（一个点子可属于多个）'], /^File into folder/)
  assert.match(EN_MESSAGES['归入文件夹 ▾'], /^File into folder/)
  assert.match(EN_MESSAGES['AI 关联（已选 {n}）'], /link/i)
})

/**
 * Диапазоны аргументов `t(…)`: сбалансированные скобки.
 * Нужно потому, что часть ключей достигается выражением внутри вызова —
 * `t(mode === 'create' ? '新建文件夹' : '重命名文件夹')`. Литералы внутри такого вызова
 * обёрнуты, хотя непосредственно перед ними нет `t(`.
 */
function wrappedSpans(text) {
  const spans = []
  for (const m of text.matchAll(/\bt\(/g)) {
    let i = m.index + 2
    let depth = 1
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    spans.push([m.index, i])
  }
  return spans
}

test('окно формы папки (issue #15) говорит на t(): ни одного необёрнутого литерала и все ключи заведены', () => {
  /**
   * v1.17.1 вернул окно «新建 / 重命名文件夹» в `WorkbenchOverlays.tsx` — и сделал это осознанно
   * без `t()` («深层 i18n 是 issue #12 的后续范围»). Этот тест — тот самый следующий заход:
   * он не трогает остальную часть файла (там ещё ≈18 подписей другой области), а проверяет
   * ровно тот блок, который относится к вкладке点子.
   */
  const source = stripComments(read('src/client/app/WorkbenchOverlays.tsx'))
  const start = source.indexOf('{folderForm !== null && (')
  assert.ok(start !== -1, 'якорь `{folderForm !== null && (` не найден — окно папок переехал, синхронизируйте тест')
  const end = source.indexOf('</Modal>', start)
  assert.ok(end > start, 'блок окна не закрыт `</Modal>` — якорь съехал')
  const block = source.slice(start, end)
  const spans = wrappedSpans(block)

  const unwrapped = []
  const missing = []
  for (const m of block.matchAll(/(['"`])((?:[^'"`\\\n]|\\.)*)\1/g)) {
    if (!CJK.test(m[2])) continue
    const key = decode(m[2])
    if (!spans.some(([from, to]) => m.index >= from && m.index < to)) {
      unwrapped.push(key)
      continue
    }
    if (!(key in EN_MESSAGES)) missing.push(key)
  }
  assert.deepEqual(unwrapped, [], `в окне формы папки остались необёрнутые литералы: ${unwrapped.join(' | ')}`)
  assert.deepEqual(missing, [], `нет словарных статей: ${missing.join(' | ')}`)
})

test('окно формы папки: два режима называются согласованно с кнопкой и с вкладкой', () => {
  // Заголовок окна, кнопка в панели инструментов и вкладка счётчика должны говорить одними
  // словами: New folder / Rename folder / Folders (n). Иначе «新建文件夹» и «重命名文件夹»
  // откроют окно, которое подписано другим термином, а вкладка рядом назовёт то же третье.
  assert.equal(EN_MESSAGES['新建文件夹'], 'New folder')
  assert.equal(EN_MESSAGES['重命名文件夹'], 'Rename folder')
  assert.equal(EN_MESSAGES['文件夹（{n}）'], 'Folders ({n})')
  assert.equal(EN_MESSAGES['创建'], 'Create')
  assert.equal(EN_MESSAGES['保存'], 'Save')
  // Подсказка в подвале окна обязана называть ту же вкладку, что и сам список:「未归类」= Unfiled.
  assert.match(EN_MESSAGES['文件夹 = 点子王；删除文件夹不会删除点子，它们会回到「未归类」'], /Unfiled/)
})
