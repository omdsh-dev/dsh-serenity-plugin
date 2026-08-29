/**
 * tsdown.config.ts — 双 bundle 预设（仿 dsh-external/dsh-ui-progress 自包含版）
 *
 *  - lib/index.js  — Node half（宿主 Loader 导入）
 *  - lib/invariant.js — 不变量伴生
 *  - lib/client.js — 浏览器 bundle：closure factory 交给
 *    window.__ModuleLoader__.load({ id, factory })；平台模块（react、
 *    @deepseek-ai/dsh-client-*）经 loader 冻结模块表解析为 external。
 *  - CSS：普通 .css 经内联插件注入 <style data-sp-css>（零依赖，无需 lightningcss）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@shgroup/dsh-serenity-hooks'

/** web shell 冻结模块表中的平台模块（external，不打包） */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
] as const

const isExternal = (source: string): boolean => PLATFORM_MODULES.includes(source as never)

/** CSS 虚拟模块前缀（resolveId 返回 \0 开头，避免被外部解析） */
const CSS_VIRTUAL_PREFIX = '\0sp-css:'

export default [
  {
    // Node half
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    // v1.25.9：marked（Skiff 调试页 markdown 渲染）打包进 lib/index.js——
    // 非 DSH 生态依赖（peerDeps 不覆盖），插件运行时无 node_modules 解析面
    noExternal: ['marked'],
  },
  {
    // Browser bundle: lib/client.js, served by the harness at /plugins/<id>/client.js
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...PLATFORM_MODULES],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    noExternal: (id: string) => (isExternal(id) ? undefined : true),
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (isExternal(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module — `
            + 'cross-plugin value imports are forbidden; collaborate through cordis services',
          )
        },
      },
      {
        // CSS 内联：把 .css 编译为「注入 <style data-sp-css>」模块（执行时一次注入）
        // 虚拟 id 去掉 .css 后缀（tsdown 0.22 css-guard 会拦截 .css 结尾的模块并要求 @tsdown/css）
        name: 'dsh-css-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css')) return null
          if (!importer) throw new Error(`css-inline: cannot resolve "${source}" without an importer`)
          const abs = resolvePath(dirname(importer), source)
          return CSS_VIRTUAL_PREFIX + abs.replace(/\.css$/, '')
        },
        load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const file = virtualId.slice(CSS_VIRTUAL_PREFIX.length) + '.css'
          this.addWatchFile(file)
          const css = readFileSync(file, 'utf-8')
          // v1.23.2 修复：每个 CSS 用**文件名唯一 marker**（`data-sp-css="<basename>"`）——
          // 旧实现所有 CSS 共用 `style[data-sp-css]`：第一个注入后创建该 style，
          // 后续 CSS 的幂等判断（querySelector 非 null）全部跳过 → 面板只剩第一个 CSS
          // 生效（"网页丢失资源"外观，S142 用户反馈）。按文件独立 marker 后各自注入。
          const id = file.split(/[\\/]/).pop()?.replace(/\.css$/, '') ?? 'sp'
          const marker = `style[data-sp-css="${id}"]`
          return [
            `const css = ${JSON.stringify(css)};`,
            `if (typeof document !== 'undefined' && document.querySelector(${JSON.stringify(marker)}) === null) {`,
            `  const tag = document.createElement('style');`,
            `  tag.setAttribute('data-sp-css', ${JSON.stringify(id)});`,
            `  tag.textContent = css;`,
            `  document.head.appendChild(tag);`,
            `}`,
            `export default css;`,
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
