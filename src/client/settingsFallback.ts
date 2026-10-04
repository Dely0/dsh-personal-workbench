/**
 * D17 / P5-1：从入口搬出的**纯数据兜底**（无 React、无 DOM、无请求）。
 *
 * 它有两个调用方，都不适合"拥有"它：设置域的 hook（`hooks/useWorkbenchSettings.ts`
 * 装载 `GET /api/workbench/settings` 的那一步）与入口里仍然留着的 quick-intake 两个写入点
 * （`rememberQuickWorkspace` / `forgetQuickWorkspace`，属 P6 的 QuickIntake 域）。
 * 按设计 §3「可测试的纯判定搬到独立模块、不放进入口」，落在这里。
 */
import { DEFAULT_ESTIMATE_MINUTES } from './capacity.js'
import type { WorkbenchSettings } from '../shared/contracts.js'

/** 容量两项偏好的兜底值（与 `capacity.ts` 的常量同值：一处读书、一处落库，必须一致）。 */
const SETTINGS_FALLBACK = {
  defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES,
  dailyCapacityIncludeOverdue: false,
} as const

/**
 * 把服务端返回的 settings 补上「客户端必需、但服务端可能还没给」的字段。
 *
 * 为什么必须有它（**装盘后实测踩到，不是假想**）：装盘完成、宿主还没重启的那段时间里，
 * 宿主仍在跑**旧的服务端代码**，`GET /api/workbench/settings` 的响应里**没有**
 * `defaultEstimateMinutes` / `dailyCapacityIncludeOverdue`。此时直接 `setSettings(r.settings)`
 * 会把新键冲成 `undefined`，界面就显示成
 * 「预计耗时：默认 **undefined** 分钟（未单独设置）」—— 一句暴露给用户的怪话，
 * 而且看起来像产品 bug（真机脚本第一次跑就把它逮住了）。
 *
 * 兜底只补**缺失**的键（`??`），不覆盖服务端明确给出的值；重启后服务端给出真值，兜底自然失效。
 */
export function withSettingsFallback(settings: WorkbenchSettings): WorkbenchSettings {
  return {
    ...settings,
    defaultEstimateMinutes: settings.defaultEstimateMinutes ?? SETTINGS_FALLBACK.defaultEstimateMinutes,
    dailyCapacityIncludeOverdue: settings.dailyCapacityIncludeOverdue ?? SETTINGS_FALLBACK.dailyCapacityIncludeOverdue,
  }
}
