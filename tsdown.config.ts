import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const ID = '@dely0/dsh-personal-workbench'

/**
 * 本次构建的标识（plan.md V04-B）。
 *
 * 由 `scripts/build-info.mjs` 在 `tsc`/`tsdown` **之前**写进 `lib/build-info.json`
 * （`pnpm build` 的顺序就是 rm → build-info → tsc → tsdown）。这里**只读**那个文件，
 * 不再自己算一遍 —— 两个地方各算一次就是"同一语义两处实现"，迟早漂移。
 *
 * 读不到时用 `'unknown'`：验收链会因为三方标识不匹配而**明确失败**，比悄悄编个假值安全。
 */
function readBuildId(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./lib/build-info.json', import.meta.url), 'utf8')) as { buildId?: string }
    return typeof parsed.buildId === 'string' && parsed.buildId !== '' ? parsed.buildId : 'unknown'
  } catch {
    return 'unknown'
  }
}

const BUILD_ID = readBuildId()

/**
 * DSH client 插件协议：lib/client.js 必须是一个
 * window.__ModuleLoader__.load({ id, factory }) 的 CommonJS 包。
 * react 家族与 @deepseek-ai/* 走 loader 的 module table，不打包进本插件。
 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
]

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  /**
   * react-dom 是 CommonJS 且带 `process.env.NODE_ENV` 分支；浏览器没有 process，
   * 不折叠这处引用会让插件在 `__ModuleLoader__` 里直接抛 "process is not defined"。
   * 固定成 production 同时把 React 的开发期告警代码整段摇掉。
   */
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    /**
     * `globalThis.__WORKBENCH_BUILD_ID__` 就是"client 内联的构建标识"：
     * 它在 bundle **最外层**执行（早于 loader 注册），与 `lib/build-info.json`、
     * health 返回的 buildId 同源；浏览器根节点上的 `data-workbench-build-id` 读的是**它**，
     * 不是 health 的值（照抄 health 就证明不了"浏览器真的加载了本次 bundle"）。
     */
    banner: `globalThis.__WORKBENCH_BUILD_ID__ = ${JSON.stringify(BUILD_ID)};\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [clientConfig]
