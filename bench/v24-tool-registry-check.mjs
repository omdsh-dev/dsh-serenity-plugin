#!/usr/bin/env node
/**
 * v24-tool-registry-check.mjs — V24 工具注册名判据（2026-10-18，cognitive trajectory 更名的产物）
 *
 * ## 为什么需要这条（R↓）
 *
 * v1.65.0 把工具名 `container_trajectory` 硬切成 `cognitive_trajectory`（无别名）。
 * 那次改名的**最大风险面不在代码，而在"工具名是字符串契约"**：
 *
 *   · `REGISTERED_TOOLS`（插件侧）与 `dsh.plugin.json`（声明侧）容易自洽，
 *     但两者**同时错**是可能的 —— 这正是 v1.31.0 踩过的「双侧陈旧一致 = 静默通过」。
 *   · `tools.restrict({ deny })` 按**工具名字符串**匹配，且 DSH 契约规定
 *     未注册的名字会让**整次调用失败** ⇒ 白名单与注册名不一致时，
 *     该角色**静默失去工具**（无报错）。
 *
 * 所以本探针的判据**刻意不用我们自己的常量**，而是：
 *   ① 从**插件加载后的真实注册面**取工具名（`lib/index.js` 的 REGISTERED_TOOLS 是**发布物**，
 *      不是源码 —— 读它 + 读 manifest，两者必须一致）；
 *   ② 与 `dsh.plugin.json` 的 `contributes.tools` 逐项对读；
 *   ③ **点名新名必须在册、旧名必须不在册** —— 这条是硬钉：改名只做一半时它会当场红。
 *
 * 🔴 本轨既有判据：**"参数传对了 ≠ 效果达成了"** ⇒ 这里不满足于"文件里写着新名"，
 *    而是要求**加载后的实现**导出的注册面确实是新名。
 *
 * ## 输出契约（verify.sh 逐行 grep）
 *   `PASS V24x <label>` / `FAIL V24x <label> <reason>`
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const PLUGIN_DIR = '/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks'
const OLD_NAME = 'container_trajectory'
const NEW_NAME = 'cognitive_trajectory'

const out = []
const pass = (id, label) => out.push(`PASS ${id} ${label}`)
const fail = (id, label, reason) => out.push(`FAIL ${id} ${label} ${reason}`)

/**
 * 找插件安装目录。
 *
 * 🔴 站点实测（2026-10-18）：容器里插件装在 **`/root/.dsh/profiles/web/node_modules/@shgroup/…`**，
 *    而**不是**常见的 `/usr/local/lib/node_modules/...`。本轨既有判据：
 *    **"探针硬写本机路径"是读数器坏掉的头号原因**（续 143/144 一轮踩三次）
 *    ⇒ 这里给多个候选 + 一路兜底，任一命中即可；全不命中才报"读数器缺失"。
 */
function findPluginDir() {
  const cands = [
    '/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks',
    '/root/.dsh/profiles/*/node_modules/@shgroup/dsh-serenity-hooks',
    '/usr/local/lib/node_modules/@shgroup/dsh-serenity-hooks',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@shgroup/dsh-serenity-hooks',
    join(process.cwd(), 'hooks/dsh-serenity-hooks'),
  ]
  for (const c of cands) {
    if (c.includes('*')) continue
    if (existsSync(join(c, 'dsh.plugin.json'))) return c
  }
  // 通配兜底：扫 profiles/ 下所有 profile
  try {
    const base = '/root/.dsh/profiles'
    if (existsSync(base)) {
      for (const p of readdirSync(base)) {
        const c = join(base, p, 'node_modules/@shgroup/dsh-serenity-hooks')
        if (existsSync(join(c, 'dsh.plugin.json'))) return c
      }
    }
  } catch {
    /* 兜底失败按"找不到"处理 */
  }
  return null
}

const dir = findPluginDir()

// ── V24 读数器自证：插件安装目录与清单可读 ──
if (!dir) {
  fail('V24', '读数器自证：找到插件安装目录', '三处候选都找不到 dsh.plugin.json ⇒ 先确认插件真的装了')
  console.log(out.join('\n'))
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(join(dir, 'dsh.plugin.json'), 'utf-8'))
} catch (e) {
  fail('V24', '读数器自证：dsh.plugin.json 可解析', `${dir}/dsh.plugin.json 读不出: ${e.message}`)
  console.log(out.join('\n'))
  process.exit(1)
}

const declared = Array.isArray(manifest?.contributes?.tools) ? manifest.contributes.tools : []
pass('V24', `读数器自证：清单可读（${dir}，声明 ${declared.length} 个工具）`)

// ── V24a：**加载后的实现**导出的注册面（不是源码，是发布物）──
// 用 createRequire 锚在插件自己的 lib/index.js 上（本轨判据：探针的依赖解析必须先自证）
let registered = null
let regErr = ''
try {
  const req = createRequire(join(dir, 'lib/index.js'))
  const mod = req(join(dir, 'lib/invariant.js'))
  if (Array.isArray(mod.REGISTERED_TOOLS)) registered = mod.REGISTERED_TOOLS
  else regErr = 'lib/invariant.js 存在但没有导出 REGISTERED_TOOLS 数组'
} catch (e) {
  regErr = `${e.message}`
}

if (registered === null) {
  fail('V24a', '发布物导出的注册面可读', regErr)
} else {
  pass('V24a', `发布物导出的注册面可读（REGISTERED_TOOLS ${registered.length} 项）`)

  // ── V24b：注册面与声明面**逐项**一致（不看总数 —— 总数相等证明不了"该在的在"）──
  const missingInDecl = registered.filter((t) => !declared.includes(t))
  const missingInReg = declared.filter((t) => !registered.includes(t))
  if (missingInDecl.length === 0 && missingInReg.length === 0) {
    pass('V24b', '注册面与 dsh.plugin.json 声明面逐项一致')
  } else {
    fail(
      'V24b',
      '注册面与 dsh.plugin.json 声明面逐项一致',
      `声明缺[${missingInDecl.join(',')}] 注册缺[${missingInReg.join(',')}]`,
    )
  }
}

// ── V24c：🔴 硬钉 —— 新名必须在册 ∧ 旧名必须不在册 ──
// 这是"改名只做一半"的唯一机械判据：白名单已改、注册名没改（或反之）都会在这里现形。
const reg = registered ?? declared
const hasNew = reg.includes(NEW_NAME)
const hasOld = reg.includes(OLD_NAME)
if (hasNew && !hasOld) {
  pass('V24c', `工具名已完全切换（在册: ${NEW_NAME}；旧名 ${OLD_NAME} 不在册）`)
} else if (hasNew && hasOld) {
  fail('V24c', '工具名切换不彻底', `新旧并存：${NEW_NAME} 与 ${OLD_NAME} 同时注册`)
} else if (!hasNew && hasOld) {
  fail('V24c', '工具名未切换', `仍是旧名 ${OLD_NAME} ⇒ 白名单若已改会让角色静默失工具`)
} else {
  fail('V24c', '工具名缺失', `新名 ${NEW_NAME} 与旧名都不在册（注册面坏了？）`)
}

// ── V24d：声明面同一组判据（两份清单可能各自漂移）──
const dHasNew = declared.includes(NEW_NAME)
const dHasOld = declared.includes(OLD_NAME)
if (dHasNew && !dHasOld) {
  pass('V24d', `声明面一致（contributes.tools 含 ${NEW_NAME}，不含旧名）`)
} else {
  fail('V24d', '声明面不一致', `含新名=${dHasNew} 含旧名=${dHasOld}`)
}

console.log(out.join('\n'))
const anyFail = out.some((l) => l.startsWith('FAIL '))
process.exit(anyFail ? 1 : 0)
