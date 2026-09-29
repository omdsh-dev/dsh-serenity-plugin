/**
 * diagram-tail.test.ts — 轮尾图行（v1.51.3）
 *
 * 两段，各自守一类东西：
 *
 * ① **纯派生逻辑**（`src/client/diagram-tail.ts`）——真值测试。
 *    本仓 client 单测跑在 node（`vitest.config.ts` 的 `environment: 'node'`，**无 DOM**）
 *    ⇒ 不能渲染 React 行；能测、也该测的是"**从这一轮的工具调用里挑什么**"这条规则。
 *
 * ② **注册形态守卫**（读源码）——两条硬约束：
 *    - 该槽**要求** `inject` 面（实测 0.1.7-rc.1：缺它 tsc 直接报错）；
 *    - 槽名的模块增强**必须真的 import 进来**（只加 devDep/paths 不够，见 §2.5.1）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { diagramImagesOfRoots } from '../src/client/diagram-tail.js'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const tailSource = readFileSync(join(clientDir, 'DiagramImageTail.tsx'), 'utf-8')
/** 挑选器（纯模块） */
const selectorSource = readFileSync(join(clientDir, 'diagram-tail.ts'), 'utf-8')
/** 纯派生模型（`DIAGRAM_TOOL_NAME` 的定义处、`diagramResultModel` 的所在） */
const resultSource = readFileSync(join(clientDir, 'diagram-result.ts'), 'utf-8')
const entrySource = readFileSync(join(clientDir, 'index.ts'), 'utf-8')
const viewSource = readFileSync(join(clientDir, 'DiagramToolView.tsx'), 'utf-8')

/** 剥掉注释后的**代码正文**（理由见 `diagram-toolview.test.ts` 的同名函数）。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 一份形状合法的 durable 图片引用（字段 = `ImageAttachmentRef`）。 */
function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { attachmentId: 'sha256-deadbeef', mediaType: 'image/png', bytes: 4096, width: 1000, height: 600, ...overrides }
}

/** 一个**已结算**的工具结果（只填本模块读的字段）。 */
function settled(name: string, content: readonly unknown[], callId = 'call-1', subCalls: readonly unknown[] = []): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 7,
    time: 1_700_000_000_000,
    callId,
    call: { name, argsRaw: '{}' },
    callTime: 1_700_000_000_000,
    content,
    isError: false,
    subCalls,
  } as unknown as ToolCallBlock
}

/** 信封文字 + 图块（正常路径）。 */
const OK = [{ type: 'text', text: '图已生成（3 个图元 ／ 1000×600 px）' }, { type: 'image', attachment: attachment() }]

describe('diagram-tail: 从一轮的工具调用里挑图', () => {
  it('已结算的 diagram + 图块 ⇒ 取到，且 callId/seq/图引用都是原对象', () => {
    const ref = attachment()
    const got = diagramImagesOfRoots([settled('diagram', [{ type: 'image', attachment: ref }], 'call-9')])
    expect(got).toHaveLength(1)
    expect(got[0]?.callId).toBe('call-9')
    expect(got[0]?.seq).toBe(7)
    expect(got[0]?.image).toBe(ref)
  })

  it('别的工具名（哪怕带图）⇒ 不取（本行只认领 diagram）', () => {
    expect(diagramImagesOfRoots([settled('read_image', [{ type: 'image', attachment: attachment() }])])).toEqual([])
  })

  it('已结算但没贴成图（降级路径）⇒ 不取', () => {
    expect(diagramImagesOfRoots([settled('diagram', [{ type: 'text', text: '未能把图贴进对话' }])])).toEqual([])
  })

  it('图块形状非法（缺 attachmentId 等）⇒ 不取（声明不是运行期保证）', () => {
    const bad = [{ type: 'image', attachment: { mediaType: 'image/png', bytes: 1, width: 2, height: 3 } }]
    expect(diagramImagesOfRoots([settled('diagram', bad)])).toEqual([])
    const svg = [{ type: 'image', attachment: attachment({ mediaType: 'image/svg+xml' }) }]
    expect(diagramImagesOfRoots([settled('diagram', svg)])).toEqual([])
  })

  it('**运行中**的调用（没有 kind 字段）⇒ 不抛、不取', () => {
    const running = [{ callId: 'c', subCalls: [] }] as unknown as readonly ToolCallBlock[]
    expect(diagramImagesOfRoots(running)).toEqual([])
  })

  it('子调用里的 diagram ⇒ 找得到（递归遍历 subCalls）', () => {
    const root = settled('bash', [{ type: 'text', text: 'x' }], 'root', [settled('diagram', OK, 'child')])
    const got = diagramImagesOfRoots([root])
    expect(got.map((one) => one.callId)).toEqual(['child'])
  })

  it('多个 ⇒ 顺序 = 发现顺序（先根后子、按传入顺序）', () => {
    const got = diagramImagesOfRoots([
      settled('diagram', OK, 'a'),
      settled('bash', [], 'b', [settled('diagram', OK, 'c')]),
      settled('diagram', OK, 'd'),
    ])
    expect(got.map((one) => one.callId)).toEqual(['a', 'c', 'd'])
  })

  it('空数组 / 非数组 ⇒ 空（畸形快照不抛）', () => {
    expect(diagramImagesOfRoots([])).toEqual([])
    expect(diagramImagesOfRoots(undefined as unknown as readonly ToolCallBlock[])).toEqual([])
  })

  it('畸形条目（null / 非对象）⇒ 跳过，不抛', () => {
    const mixed = [null, 42, settled('diagram', OK, 'ok')] as unknown as readonly ToolCallBlock[]
    expect(diagramImagesOfRoots(mixed).map((one) => one.callId)).toEqual(['ok'])
  })

  it('🔴 深链不拖住（超过深度上限即停，且同层已找到的照常返回）', () => {
    // 造一条 200 层的链（远超 MAX_DEPTH=32），把它的**兄弟**位置上放一张真图
    let deep: ToolCallBlock = settled('bash', [], 'leaf')
    for (let i = 0; i < 200; i += 1) deep = settled('bash', [], `d${i}`, [deep])
    const root = settled('bash', [], 'root', [settled('diagram', OK, 'shallow'), deep])
    expect(diagramImagesOfRoots([root]).map((one) => one.callId)).toEqual(['shallow'])
  })
})

describe('diagram-tail: 注册形态守卫', () => {
  it('注册进 keyed 列表槽 conversation.chat.turnTail，且**带 inject 面**（缺它编译不过）', () => {
    expect(entrySource).toMatch(/slots\.inject\(\s*'conversation\.chat\.turnTail'/)
    expect(entrySource).toMatch(/name:\s*'conversation\.chat\.turnTail'/)
    expect(entrySource).toMatch(/id:\s*'serenity-diagram-tail'/)
    expect(entrySource).toMatch(/inject:\s*\(\)\s*=>\s*diagramTailInjected\(scope\)/)
  })

  it('🔴 槽名的模块增强**真的 import 进来**了（只加 devDep/paths 不够 —— §2.5.1）', () => {
    expect(code(entrySource)).toMatch(/import type \{\} from '@deepseek-ai\/dsh-client-ui-chat\/client'/)
  })

  it('ctx 经**注入面**传给组件（不依赖未声明字段、也不做模块级单例）', () => {
    expect(tailSource).toMatch(/export function diagramTailInjected\(scope: ClientContext\): DiagramTailInjected/)
    expect(tailSource).toMatch(/InjectFace<DiagramTailInjected>/)
    // 该槽的 owner 货币里**没有** loadImage ⇒ 必须走宿主自己的会话授权 URL 缓存
    expect(tailSource).toMatch(/peekImageUrl/)
    expect(tailSource).toMatch(/imageUrl\(/)
  })

  it('取数只读宿主快照（turnDataSource 的 tool-call），且纯模块**不 import 宿主的运行期值**', () => {
    expect(tailSource).toMatch(/turnDataSource\(turn, 'tool-call'\)/)
    // 纯模块只允许**类型**导入宿主包：值的导入会让宿主 client 包在 import 期要 window，
    // node 单测直接起不来（实测 ReferenceError）。这条钉住"别写回去"。
    expect(code(selectorSource)).not.toMatch(/^import \{[^}]*\} from '@deepseek-ai\//m)
    expect(code(selectorSource)).toMatch(/import type \{[^}]*\} from '@deepseek-ai\/dsh-client-ui-conversation\/client'/)
    // 已结算判定是**本模块自己的一行守卫**（宿主的 isSettledTool 是运行期值，用不了）
    expect(code(selectorSource)).toMatch(/function isSettled\(block: ToolCallBlock\): block is ToolResultNode/)
  })

  it('🔴 工具名单一真相源：字面量只在 diagram-result.ts 定义，两处消费都 import 该常量', () => {
    expect(resultSource).toMatch(/DIAGRAM_TOOL_NAME = 'diagram'/)
    // 工具卡行（keyed tool view）与轮尾行（turnTail）都**引用**它，不各写一份字面量
    expect(code(viewSource)).toMatch(/import \{ DIAGRAM_TOOL_NAME,/)
    expect(code(selectorSource)).toMatch(/import \{ DIAGRAM_TOOL_NAME,/)
    expect(code(tailSource)).toMatch(/import \{ DIAGRAM_TOOL_NAME \}/)
  })
})
