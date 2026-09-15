/**
 * acc-diag.ts（工具面）— ACC 负责人专用的运行态诊断（v1.33，S142 §32.11）
 *
 * 用户裁决（2026-09-14）：「不要 diag-live 了；或者变成一个隐藏 tool **只对 home-serenity 可见**，
 * 做成我们专属的运行时诊断工具」。⇒ 合并原 `diag`（脚本侧条件链）+ `diag-live`（进程内运行态），
 * 一次调用出全报告，并**从 CCC 工具面默认移除**。
 *
 * 可见性不在本文件判定（与 im-bridge 同一套机制）：`seams/guards.ts`
 * `syncExclusiveToolsVisibility` 在会话就绪 / pre-step 时按 CCC 配置
 * `exclusiveTools` 决定是否 `agent.ctx.tools.restrict({ deny: ['acc-diag'] })`——
 * **未声明的 CCC 看不到它**（不是"看得到但被拒"）。
 *
 * 为什么必须是独立工具而不是 `container_admin` 的一个域（§32.11 ②）：
 * `tools.restrict` 是**工具级** deny，没有域级粒度——放进 container_admin 就等于
 * 要隐藏它必须连 role/msm/config 一起隐藏。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import { cccRootForExec } from '../ccc-roots.js'
import { runAccDiag, renderAccDiag } from '../diag-ops.js'

/**
 * 运行态诊断工具（`acc-diag`）。**无动作参数**：一次调用即全报告
 * （① live 运行态 / ①b 唤醒时钟 / ③ 唤醒注册表）。
 *
 * ⚠️ 2026-09-15（ACC 侧 autopilot 退场，S142）：原四段降为三段——原 ②「面板解析」与
 * ④「唤起条件链」的主语随机制消失，已删（见 `../diag-ops.ts` 文件头；④ 的缺口已登记）。
 */
export function createAccDiagTool(ctx: Context) {
  return defineTool({
    name: 'acc-diag',
    description:
      'ACC runtime diagnosis (ACC maintainers only — hidden unless this container declares "acc-diag" in .opencode/serenity.json exclusiveTools). '
      + 'One call returns the full report (3 sections): (1) live runtime — live sessions with cwd/CCC; '
      + '(1b) wake clock — the wake scheduler process snapshot (armed / gate / ticks / last tick / last skip reason); '
      + '(3) wake registry — entries with state/at/target/lastResult plus the catch-up window. '
      + 'Read-only: it inspects process state and files, it changes nothing.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    async execute(_args, exec) {
      const root = cccRootForExec(exec)
      if (!root) {
        return {
          ok: false,
          code: 'CCC_UNRESOLVED',
          error: 'this session is not inside a Serenity container (no .serenity marker found from the session cwd)',
          report: '',
        }
      }
      return { ok: true, code: '', error: '', report: renderAccDiag(await runAccDiag(ctx, root)) }
    },
  })
}
