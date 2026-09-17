/**
 * 分类 Tab 条（知识库与任务页共用）。
 *
 * ## 为什么抽出来
 *
 * 两个页面都要「用 Tab 取代长下拉」，而且**都带条数徽标**。各写一份就是同一语义两处实现
 * （本项目最大的 bug 类别），所以形态、选中态、多选规则都只在这一个文件里定义。
 *
 * ## 多选规则（用户确认的交互）
 *
 * 点 Tab = 单选；**Ctrl/Cmd + 点击 = 多选切换**。选中集合是 `string[]`，`[ALL]` 表示"全部"。
 * 规则本身抽成纯函数 `toggleTab`，可以被单测直接覆盖。
 */
import type { Dict } from '../viewTypes.js'

/** 「全部」伪分类的 code（与 `listPresentation.ALL_TAB` 同值，但这里不 import 它以免纯模块被 React 依赖）。 */
export const ALL = 'all'

export interface TabItem {
  code: string
  name: string
  /** 有颜色就画一个小圆点（知识类型/点子类型现在出厂就带 color）。 */
  color?: string
  count: number
}

/**
 * 从字典生成 Tab 项：`全部` + 每个 dict 条目 + 可选的「其他」。
 * `counts` 由 `listPresentation` 的判定给出（不受当前 Tab 限制，所以能回答"切过去有几条"）。
 */
export function buildTabs(dicts: readonly Dict[], counts: Readonly<Record<string, number>>, options: { allLabel?: string; includeOther?: boolean } = {}): TabItem[] {
  const tabs: TabItem[] = [{ code: ALL, name: options.allLabel ?? '全部', count: counts[ALL] ?? 0 }]
  for (const entry of dicts) {
    tabs.push({ code: entry.code, name: entry.name, color: String(entry.config.color ?? ''), count: counts[entry.code] ?? 0 })
  }
  if (options.includeOther !== false && (counts.other ?? 0) > 0) {
    tabs.push({ code: 'other', name: '其他', count: counts.other ?? 0 })
  }
  return tabs
}

/**
 * 选中态的**唯一**实现：单选替换、Ctrl/Cmd 多选切换。
 *
 * - 空选择 = 「全部」（`[ALL]`），这样调用方不需要再判"没选"；
 * - `全部` 本身不可与别的项共存：Ctrl 点「全部」= 清空回全部；
 * - 多选时若把最后一个具体类型取消掉，自动回落到「全部」。
 */
export function toggleTab(selected: readonly string[], code: string, multi: boolean): string[] {
  if (!multi) return [code]
  if (code === ALL) return [ALL]
  const concrete = selected.filter((c) => c !== ALL)
  const next = concrete.includes(code) ? concrete.filter((c) => c !== code) : [...concrete, code]
  return next.length === 0 ? [ALL] : next
}

/** 当前选中项（用于高亮）：多选时"全部"只在真的全选时算选中。 */
export function isTabActive(selected: readonly string[], code: string): boolean {
  if (code === ALL) return selected.length === 0 || selected.every((c) => c === ALL) || selected.includes(ALL)
  return selected.includes(code)
}

export function TabBar({ tabs, selected, onSelect, ariaLabel = '分类' }: {
  tabs: readonly TabItem[]
  selected: readonly string[]
  onSelect: (code: string, multi: boolean) => void
  ariaLabel?: string
}): JSX.Element {
  return (
    <div className="wb-tabs" role="tablist" aria-label={ariaLabel} data-tabbar>
      {tabs.map((tab) => (
        <button
          key={tab.code}
          type="button"
          role="tab"
          aria-selected={isTabActive(selected, tab.code)}
          className={`wb-tab ${isTabActive(selected, tab.code) ? 'on' : ''}`}
          data-tab={tab.code}
          // Ctrl/Cmd 是"多选"的修饰键：从事件里读，不让调用方各自判断
          onClick={(e) => onSelect(tab.code, e.ctrlKey || e.metaKey)}
        >
          {tab.color !== undefined && tab.color !== '' && <i className="wb-tab-dot" style={{ background: tab.color }} />}
          {tab.name}
          <span className="wb-tab-cnt">{tab.count.toLocaleString('zh-CN')}</span>
        </button>
      ))}
    </div>
  )
}
