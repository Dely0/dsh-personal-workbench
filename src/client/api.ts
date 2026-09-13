/**
 * 工作台 HTTP 调用封装：非 2xx 时抛出后端返回的 error 文案。
 *
 * ## 为什么要对"网络级失败"做重试（v1.14.49）
 *
 * 2026-09-13 用户在 WSL 上反馈"点任务报 **Failed to fetch**"。抓包定位到：
 * 点一个任务会并发发 5 个请求（详情 / 事件 / 复盘 / 相关知识 / 草稿），
 * 而**那一刻宿主恰好不在**（实测该环境里 WSL VM 约每 90 秒重启一次）
 * → 5 个请求全部 `net::ERR_CONNECTION_REFUSED` → 浏览器统一报 `Failed to fetch`。
 *
 * 服务在"请求发出前那一刻不在"与"服务在处理时报错"是两回事：
 * 前者是**瞬时故障**（服务重启、连接被掐），后者才是真的业务错误。
 * 对前者立刻失败并弹一个英文原始错误，用户既看不懂也无从下手。
 *
 * 所以：
 *   1. **只对网络级失败重试**（`TypeError: Failed to fetch` 这一类 —— fetch 在网络层
 *      失败时才 reject；HTTP 4xx/5xx 会正常 resolve，**不重试**，否则会给后端加压）；
 *   2. 默认重试 2 次、间隔 400ms / 900ms —— 覆盖"服务正在重启"的典型窗口；
 *   3. 重试仍失败时抛**中文可读**的错误，并带上路径，便于用户反馈与排查。
 */

/** fetch 在网络层失败时抛的就是 TypeError；用它区分"连不上"与"服务返回错误"。 */
function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  const message = error.message.toLowerCase()
  return message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('load failed')
    || message.includes('network request failed')
}

const RETRY_DELAYS_MS = [400, 900]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 带瞬时故障重试的 fetch。
 *
 * @param path - 请求路径（相对路径，交给同源解析）。
 * @param init - 与 fetch 相同。
 * @returns 成功的 Response（**非 2xx 也会返回**，由调用方决定怎么处理）。
 */
async function fetchWithRetry(path: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(path, init)
    } catch (error) {
      lastError = error
      // 只重试网络级失败；其余（例如被 AbortController 取消）立刻抛出
      if (!isNetworkFailure(error)) throw error
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
  }
  throw lastError
}

/**
 * 发起一次工作台 API 调用。
 *
 * - 网络级失败会自动重试（见 `fetchWithRetry`）；
 * - 非 2xx：抛出**后端返回的 error 文案**（有的话），并附上状态码便于定位；
 * - 网络级失败重试耗尽：抛出中文提示 + 路径，**不再是裸的 "Failed to fetch"**。
 *
 * @param path - 请求路径。
 * @param init - 与 fetch 相同。
 * @returns 响应体 JSON。
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetchWithRetry(path, init)
  } catch (error) {
    /**
     * 走到这里说明重试也没连上 —— 典型是宿主正在重启 / 连接被掐断。
     * 给一句用户能看懂、也能拿去反馈的话，而不是浏览器的英文原文。
     */
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法连接工作台服务（${path}）：${detail}。服务可能正在重启，稍后重试即可。`)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}（${path}）`)
  return body as T
}
