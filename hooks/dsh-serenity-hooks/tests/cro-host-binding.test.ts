/**
 * cro-host-binding.test.ts — CRO 机器绑定（所有者令 2026-10-15，S142 D135）
 *
 * ## 被测语义（所有者逐字）
 * 「**CRO 必须指定绑定机器，否则不运行，唤醒器 检查这个**」
 *  ＋「用 hostname 吧，比较合理」
 *  ＋「不改名，家里就这几台机器没必要」（⇒ 撞名风险已由所有者接受）
 *
 * ⇒ 三条同时成立：① **只许这一台**（白名单）② **fail-closed**（没绑 = 不跑）
 *   ③ 检查者 = **唤醒器**（`runCroPhase`，不是程序自己判）
 *
 * ## 本文件覆盖什么
 *  - `parseCroHostBinding`：**纯函数**全边界（空 / 注释 / 空行 / 多行 / CRLF / 空白）
 *  - `resolveCroHostBinding`：**四态**（bound-to-self / not-bound / bound-to-other / read-error）
 *  - 🔴 **两条最要紧的负控**：**没绑 ⇒ 不跑**、**绑给别人 ⇒ 不跑**
 *    （这两条就是"必须指定"的字面语义；少了任一条，本机制等于没做）
 *  - 路径逃逸阻断（`resolveInside` 生效）
 *
 * ## 挑靶理由（判据纪律：挑靶四条）
 *  1. **判据本身**：`allowed` 是**唯一**决定投递与否的字段 ⇒ 每个分支都必须被钉住；
 *  2. **"没绑"与"绑给别人"必须分得开**（`code` 不同）：2026-10-15 的 `send-now` 事故
 *     正是"文案相同、原因不同"害排查指错方向（续 129 / D134）⇒ 本层不许重演；
 *  3. **fail-closed 的方向**：任何异常路径（读不了 / 路径非法 / 超大）都必须落 `allowed:false`
 *     —— 反过来说，若谁把某个 catch 改成 `return true`，本文件应立刻红；
 *  4. **真故障形态注入**：用**真文件系统**（真建文件、真写内容、真造目录），
 *     不用 mock —— 因为"搬动/改名"类改动必须有**真文件那一路**的用例
 *     （v1.56.4 教训：自造夹具会漏掉真形态）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRO_HOST_FILENAME, parseCroHostBinding, resolveCroHostBinding } from '../src/cro/core.js'

const DIR_NAME = '2026-09-13--S185--desk-camera'
const SELF = 'yh-Standard-PC-Q35-ICH9-2009'
const OTHER = 'yh-Standard-PC-Q35-ICH9-2008'

let root: string

/** 建一条轨迹目录（可选写绑定文件） */
function makeCognitiveTrajectory(binding?: string): string {
  const dir = join(root, 'AGENT_SESSIONS', DIR_NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  if (binding !== undefined) writeFileSync(join(dir, CRO_HOST_FILENAME), binding, 'utf-8')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cro-host-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── parseCroHostBinding（纯函数，全边界）──

describe('parseCroHostBinding: 纯函数边界', () => {
  it('单行机器名 ⇒ 原样返回', () => {
    expect(parseCroHostBinding(SELF)).toBe(SELF)
  })

  it('首尾空白（空格/制表/换行）被裁掉', () => {
    expect(parseCroHostBinding(`  \t${SELF}  \n`)).toBe(SELF)
  })

  it('CRLF（Windows 换行）也认', () => {
    expect(parseCroHostBinding(`${SELF}\r\n`)).toBe(SELF)
  })

  it('空串 ⇒ null', () => {
    expect(parseCroHostBinding('')).toBeNull()
  })

  it('🔴 只有注释与空行 ⇒ null（**不是**空串——那会让"没绑"看起来像"绑了个空名"）', () => {
    expect(parseCroHostBinding('# 这条轨迹绑给谁\n\n   \n# 还是注释\n')).toBeNull()
  })

  it('注释在前、机器名在后 ⇒ 取机器名（人可以在绑定文件里留痕）', () => {
    expect(parseCroHostBinding(`# 绑给 CCC 宿主\n${SELF}\n`)).toBe(SELF)
  })

  it('🔴 多行有效内容 ⇒ 只取**第一条**（多余的行不参与判定）', () => {
    expect(parseCroHostBinding(`${SELF}\n${OTHER}\n`)).toBe(SELF)
  })

  it('前后有内容的行内空白 ⇒ 保留（机器名里的空白不是我们要裁的）', () => {
    expect(parseCroHostBinding('  a b  \n')).toBe('a b')
  })
})

// ── resolveCroHostBinding（四态）──

describe('resolveCroHostBinding: 四态判定', () => {
  it('✅ 绑定本机 ⇒ allowed=true / code=bound-to-self', () => {
    makeCognitiveTrajectory(SELF)
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(true)
    expect(v.code).toBe('bound-to-self')
    expect(v.bound).toBe(SELF)
    expect(v.self).toBe(SELF)
  })

  it('🔴 负控 A：**没有绑定文件 ⇒ 不跑**（fail-closed，"必须指定"的字面语义）', () => {
    makeCognitiveTrajectory() // 不写绑定文件
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('not-bound')
    expect(v.bound).toBeNull()
  })

  it('🔴 负控 B：**绑定给别的机器 ⇒ 本机不跑**（这正是"确保不在指定机器上发生"）', () => {
    makeCognitiveTrajectory(OTHER)
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('bound-to-other')
    // 两个名字都要**回显**：排查时要一眼看出"绑给了谁、我是谁"
    expect(v.bound).toBe(OTHER)
    expect(v.self).toBe(SELF)
  })

  it('🔴 "没绑"与"绑给别人"是**两个不同的 code**（不许合并——否则排查指错方向）', () => {
    makeCognitiveTrajectory()
    const notBound = resolveCroHostBinding(root, DIR_NAME, SELF)
    makeCognitiveTrajectory(OTHER)
    const other = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(notBound.code).not.toBe(other.code)
    expect(notBound.detail).not.toBe(other.detail)
  })

  it('文件只有注释 ⇒ 判"没绑"（不是"绑给空名"）', () => {
    makeCognitiveTrajectory('# TODO: 填机器名\n')
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('not-bound')
  })

  it('文件为空 ⇒ 判"没绑"', () => {
    makeCognitiveTrajectory('')
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('not-bound')
  })

  it('轨迹目录不存在 ⇒ 判"没绑"（不抛）', () => {
    const v = resolveCroHostBinding(root, 'no-such-dir', SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('not-bound')
  })

  it('本机名为空串 ⇒ **一律不通过**（fail-closed，不是"取不到就随便跑"）', () => {
    makeCognitiveTrajectory(SELF)
    const v = resolveCroHostBinding(root, DIR_NAME, '')
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('bound-to-other')
  })

  it('大小写不同 ⇒ 视为不同机器（不做大小写折叠——机器名是精确串）', () => {
    makeCognitiveTrajectory(SELF.toUpperCase())
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('bound-to-other')
  })
})

// ── 异常路径必须 fail-closed ──

describe('resolveCroHostBinding: 异常路径一律 fail-closed', () => {
  it('🔴 绑定文件过大（写错了）⇒ 不跑，且 code=read-error', () => {
    makeCognitiveTrajectory('x'.repeat(2_048))
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('read-error')
  })

  it('🔴 路径逃逸（dirName 带 ../）⇒ 不跑（resolveInside 生效，不抛）', () => {
    const v = resolveCroHostBinding(root, '../../etc', SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('read-error')
  })

  it('🔴 目录当文件（同名目录）⇒ 不跑，绝不抛', () => {
    // 真故障形态：把"绑定文件"造成**目录** ⇒ readFileSync 会 EISDIR
    const dir = makeCognitiveTrajectory()
    mkdirSync(join(dir, CRO_HOST_FILENAME), { recursive: true })
    const v = resolveCroHostBinding(root, DIR_NAME, SELF)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('read-error')
  })

  it('🔴 不可读文件（chmod 000）⇒ 不跑（**仅非 root 时有效**——root 下读得动，跳过该断）', () => {
    // 判据纪律：`chmod 000` 在 root 下拦不住读取 ⇒ 该故障形态**默认不可构造**。
    // 本用例在 root 环境下**会正确地读成功**，故不断言结果，只断言"绝不抛"。
    makeCognitiveTrajectory(SELF)
    const file = join(root, 'AGENT_SESSIONS', DIR_NAME, CRO_HOST_FILENAME)
    chmodSync(file, 0o000)
    let v: ReturnType<typeof resolveCroHostBinding> | null = null
    expect(() => {
      v = resolveCroHostBinding(root, DIR_NAME, SELF)
    }).not.toThrow()
    // 绝不抛即可；两个分支都合法（root 读得到 ⇒ allowed=true；普通用户 ⇒ read-error）
    expect(v).not.toBeNull()
  })
})

// ── 真形态：绑定文件与 CRO 程序共存于同一目录 ──

describe('绑定文件与 CRO 程序共存（真形态）', () => {
  it('🔴 两个文件同在轨迹目录 ⇒ 绑定判定不受 CRO 程序存在与否影响', async () => {
    const { CRO_FILENAME } = await import('../src/cro/core.js')
    const dir = makeCognitiveTrajectory(SELF)
    // 不写 CRO 程序时：绑定仍判通过（绑定是**独立的**一道门，不依赖程序文件）
    expect(resolveCroHostBinding(root, DIR_NAME, SELF).allowed).toBe(true)
    // 写上 CRO 程序后：判定不变
    writeFileSync(join(dir, CRO_FILENAME), '// noop\n', 'utf-8')
    expect(resolveCroHostBinding(root, DIR_NAME, SELF).allowed).toBe(true)
    // 且文件名互不相同（防"两个机制撞同名"）
    expect(CRO_HOST_FILENAME).not.toBe(CRO_FILENAME)
  })

  it('绑定文件名是全写形态（与 CRO_FILENAME 同风格，非缩写）', () => {
    expect(CRO_HOST_FILENAME).toBe('cro-host-binding')
  })
})
