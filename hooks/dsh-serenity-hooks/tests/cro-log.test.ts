/**
 * cro-log.test.ts — CRO 唤起日志的镜像测试（S142 §7.17，2026-09-20；**2026-10-19 改纯文本**）
 *
 * ## 这个模块的测试重点（**不是**"能存能取"）
 *
 * 1. 🔴 **轮转真的发生了**（所有者明示「只保留仅两日」「这个时间是程序化的」）：
 *    用**可控 `nowMs`** 注入 ⇒ 断言两日窗**外的条目被删掉**、窗**内**的留着；
 *    并断言**清理与写入是同一笔操作**（一次 append 之后文件里就只有窗内的）。
 * 2. 🔴 **失败也记**（所有者令「失败成功都记录」）：`ok:false` 的条目照样入档，
 *    且带得上失败原因 ⇒ 否则"该叫却没叫成"仍是盲区（本容器反复栽的"安静失败"）。
 * 3. 🔴 **绝不抛**：坏档 / 不可写路径 ⇒ 返回结构化失败，**不 throw**
 *    （铁律：CRO 的任何问题都不得影响投递与既有链路）。
 * 4. 🔴 **不是第二真相源**：断言本档**不含**判定细节（无 `lastDecision` / 阈值 / 谓词），
 *    只存"投递面"（成败 / 方式 / tick / 摘要）——这是与程序 `cro-state.json` 的分工边界。
 * 5. **固定文件名 + 落在该轨迹目录**（所有者令「写结构化文件到 cognitive trajectory 目录，文件名固定」）。
 * 6. 🆕 **形态 = 纯文本行**（owner 2026-10-19 裁 Q1「日志不要写 json，不合适」）
 *    ＋ **两代并读**（旧 `cro-wake-log.json` 仍读、**只写新 `.log`**）。
 *
 * ## 判据纪律（本文件自己也遵守）
 *
 * · 断言的是**磁盘上的实际内容**（读回来比对），不是内存中的返回值；
 * · `at` 用 `isoLocal()`（当地 RFC3339）⇒ 断言"可被 `Date.parse` 解析"（这是裁剪的前提）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendCroWakeLog,
  CRO_LOG_FILENAME,
  CRO_LOG_HEADER,
  CRO_LOG_LEGACY_FILENAMES,
  CRO_LOG_RETENTION_MS,
  CRO_PROMPT_HEAD_MAX,
  croWakeLogLegacyPath,
  croWakeLogPath,
  formatCroLogLine,
  loadCroWakeLog,
  parseCroLogLine,
  pruneCroLogEntries,
  summarizeCroPrompt,
  type CroWakeLogEntry,
} from '../src/cro/log.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-20T08:00:00+08:00')
const DIR = '2026-09-13--S185--相机沉淀与语音输入'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cro-log-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 直接读**磁盘**上的档（判据 = 实际内容，不是返回值）；走模块自己的解析器，不另写一份 */
function readRaw(): { entries: CroWakeLogEntry[]; text: string } {
  const text = readFileSync(croWakeLogPath(root, DIR), 'utf-8')
  return { entries: loadCroWakeLog(root, DIR).log.entries, text }
}

/** 手工铺一份"坏档/手改档"现场 */
function writeRaw(content: string): void {
  const p = croWakeLogPath(root, DIR)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

describe('落点与文件名（所有者令：写进 cognitive trajectory 目录、文件名固定）', () => {
  it('路径 = <CCC 根>/AGENT_SESSIONS/<轨迹目录>/cro-wake-log.log（纯文本，owner Q1）', () => {
    expect(croWakeLogPath('/ccc', DIR)).toBe(join('/ccc', 'AGENT_SESSIONS', DIR, CRO_LOG_FILENAME))
    expect(CRO_LOG_FILENAME).toBe('cro-wake-log.log')
  })

  it('旧名进**读取族**（不硬切）：cro-wake-log.json 仍可读，但不作为写入目标', () => {
    expect(CRO_LOG_LEGACY_FILENAMES).toContain('cro-wake-log.json')
    expect(CRO_LOG_FILENAME).not.toBe('cro-wake-log.json')
  })

  it('文件名固定：不含日期 / 版本 / 轨迹号（无任何滑动成分）', () => {
    expect(CRO_LOG_FILENAME).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(CRO_LOG_FILENAME).not.toMatch(/S\d+/)
  })

  it('未发生过唤起 ⇒ **不产生文件**（所有者令「当 CRO 存在时」；读也不建档）', () => {
    expect(existsSync(croWakeLogPath(root, DIR))).toBe(false)
    expect(loadCroWakeLog(root, DIR)).toEqual({ log: { version: 1, entries: [] }, error: null })
    expect(existsSync(croWakeLogPath(root, DIR))).toBe(false)
  })
})

describe('🆕 形态 = 纯文本行（owner Q1「日志不要写 json」）', () => {
  it('落盘是纯文本：首行是表头，之后一行一条、tab 分隔', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: '已投递（live）', tick: 82, reason: '心跳', prompt: 'abc' }, NOW)
    const { text } = readRaw()
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toBe(CRO_LOG_HEADER)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.split('\t')).toHaveLength(6)
    // 🔴 反向钉：**不得**是 JSON（这正是 owner 打回的那个形态）
    expect(text.trimStart().startsWith('{')).toBe(false)
    expect(text).not.toContain('"entries"')
  })

  it('格式与解析**互为逆运算**（含中文 / 冒号 / 反斜杠等不特殊处理的字符）', () => {
    const e: CroWakeLogEntry = {
      at: '2026-09-20T08:00:00+08:00',
      ok: false,
      detail: '无绑定会话记录（冷会话且 sessionController 缺席）',
      tick: 83,
      reason: '心跳：距上次 44m ／ 路径 C:\\x',
      promptDigest: { length: 17, head: '请先整理你的 SESSION.md' },
    }
    expect(parseCroLogLine(formatCroLogLine(e))).toEqual(e)
  })

  it('🔴 字段里的 tab / 换行被抹成空格（否则一行会变成两行或错位）', () => {
    const e: CroWakeLogEntry = {
      at: '2026-09-20T08:00:00+08:00',
      ok: true,
      detail: 'a\tb\nc',
      tick: 1,
      reason: 'r1\r\nr2',
      promptDigest: { length: 3, head: 'x\ty' },
    }
    const line = formatCroLogLine(e)
    expect(line).not.toContain('\n')
    expect(line.split('\t')).toHaveLength(6) // 分隔符数量不受内容影响
  })

  it('坏行**跳过而非报错**（半行 / 时间不可解析 / 标记不认识 / 表头注释）', () => {
    expect(parseCroLogLine('# 这是注释')).toBeNull()
    expect(parseCroLogLine('')).toBeNull()
    expect(parseCroLogLine('只有一列')).toBeNull()
    expect(parseCroLogLine('不是时间\tok\ttick=1\td\treason=\tprompt=0:')).toBeNull()
    expect(parseCroLogLine('2026-09-20T08:00:00+08:00\tyes\ttick=1\td\treason=\tprompt=0:')).toBeNull()
  })

  it('reason 空串 ⇒ null（与"取不到写 null，不留空白"同口径）', () => {
    const e = parseCroLogLine('2026-09-20T08:00:00+08:00\tok\ttick=1\td\treason=\tprompt=0:')
    expect(e!.reason).toBeNull()
    expect(e!.promptDigest).toEqual({ length: 0, head: '' })
  })
})

describe('🆕 两代并读（旧 cro-wake-log.json 仍读、只写新 .log）', () => {
  it('只有旧档 ⇒ 读得到旧档的条目', () => {
    const legacy = croWakeLogLegacyPath(root, DIR, 'cro-wake-log.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        entries: [{ at: '2026-09-20T07:00:00+08:00', ok: true, detail: '旧档', tick: 5, reason: null }],
      }),
      'utf-8',
    )
    expect(loadCroWakeLog(root, DIR).log.entries.map((e) => e.detail)).toEqual(['旧档'])
  })

  it('🔴 新档在 ⇒ **只读新档**（旧档不再参与，也不会重复计入）', () => {
    const legacy = croWakeLogLegacyPath(root, DIR, 'cro-wake-log.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        entries: [{ at: '2026-09-20T07:00:00+08:00', ok: true, detail: '旧档', tick: 5, reason: null }],
      }),
      'utf-8',
    )
    // 首次写入：旧档**窗内**条目被搬进新档（见下一条用例），随后新档接管
    appendCroWakeLog(root, DIR, { ok: true, detail: '新档', tick: 6, reason: null }, NOW)
    appendCroWakeLog(root, DIR, { ok: true, detail: '再一条', tick: 7, reason: null }, NOW)
    // 🔴 判据：旧档里的条目**不得再被计入第二次**（数 = 新档实际行数）
    expect(loadCroWakeLog(root, DIR).log.entries.map((e) => e.detail)).toEqual(['旧档', '新档', '再一条'])
    expect(loadCroWakeLog(root, DIR).log.entries).toHaveLength(2 + 1)
  })

  it('🆕 迁移不丢数据：首次写入把旧档**窗内**条目搬进新档，窗外条目照裁', () => {
    const legacy = croWakeLogLegacyPath(root, DIR, 'cro-wake-log.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        entries: [
          { at: new Date(NOW - 60_000).toISOString(), ok: true, detail: '窗内旧条', tick: 4, reason: null },
          { at: new Date(NOW - CRO_LOG_RETENTION_MS - 60_000).toISOString(), ok: true, detail: '窗外旧条', tick: 3, reason: null },
        ],
      }),
      'utf-8',
    )
    const res = appendCroWakeLog(root, DIR, { ok: true, detail: '新档', tick: 6, reason: null }, NOW)
    expect(res.pruned, '窗外旧条照常被裁').toBe(1)
    expect(loadCroWakeLog(root, DIR).log.entries.map((e) => e.detail)).toEqual(['窗内旧条', '新档'])
  })

  it('旧档坏掉（非法 JSON）⇒ 结构化失败，不 throw', () => {
    const legacy = croWakeLogLegacyPath(root, DIR, 'cro-wake-log.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, '{ 这不是 JSON', 'utf-8')
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error).toContain('解析失败')
    expect(log.entries).toEqual([])
  })
})

describe('追加：成功与失败**都记**（所有者令「失败成功都记录」）', () => {
  it('成功一条 ⇒ 落盘且字段齐全（含 tick / 摘要 / reason）', () => {
    const res = appendCroWakeLog(
      root,
      DIR,
      { ok: true, detail: '已投递（live）', tick: 82, reason: '心跳：距上次 44m', prompt: '请先整理你的 SESSION.md' },
      NOW,
    )
    expect(res).toMatchObject({ ok: true, error: null, kept: 1, pruned: 0, dropped: 0 })
    const entries = readRaw().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ ok: true, detail: '已投递（live）', tick: 82, reason: '心跳：距上次 44m' })
    expect(entries[0]!.promptDigest).toEqual({ length: 17, head: '请先整理你的 SESSION.md' })
    expect(Number.isNaN(Date.parse(entries[0]!.at))).toBe(false) // 裁剪的前提
  })

  it('失败一条 ⇒ 照样入档 + 带失败原因（否则"该叫没叫成"仍是盲区）', () => {
    appendCroWakeLog(
      root,
      DIR,
      { ok: false, detail: '无绑定会话记录（冷会话且 sessionController 缺席）', tick: 83, reason: null, prompt: 'x' },
      NOW,
    )
    const e = readRaw().entries[0]!
    expect(e.ok).toBe(false)
    expect(e.detail).toContain('无绑定会话记录')
    expect(e.reason).toBeNull() // 程序没给理由 ⇒ 显式 null（不留空白）
  })

  it('连写多条 ⇒ 按写入顺序累加（不覆盖前条）', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: 'A', tick: 1, reason: null }, NOW - 3000)
    appendCroWakeLog(root, DIR, { ok: true, detail: 'B', tick: 2, reason: null }, NOW - 2000)
    appendCroWakeLog(root, DIR, { ok: true, detail: 'C', tick: 3, reason: null }, NOW - 1000)
    expect(readRaw().entries.map((e) => e.detail)).toEqual(['A', 'B', 'C'])
  })
})

describe('🔴 轮转：两日窗 + 程序化（清理与写入同一笔操作）', () => {
  it('窗外的条目在**写入那一刻**被删掉（不是靠另设清理步），且报出裁了几条', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: '很旧', tick: 1, reason: null }, NOW - CRO_LOG_RETENTION_MS - 60_000)
    expect(readRaw().entries).toHaveLength(1) // 单写时它就是窗内基数
    const res = appendCroWakeLog(root, DIR, { ok: true, detail: '新', tick: 2, reason: null }, NOW)
    expect(res.pruned).toBe(1)
    expect(res.kept).toBe(1)
    expect(readRaw().entries.map((e) => e.detail)).toEqual(['新']) // 旧条目已随这次写入消失
  })

  it('窗内（距界 1 分钟）的条目**必须留着**（边界不误杀）', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: '刚好在窗内', tick: 1, reason: null }, NOW - CRO_LOG_RETENTION_MS + 60_000)
    const res = appendCroWakeLog(root, DIR, { ok: true, detail: '新', tick: 2, reason: null }, NOW)
    expect(res.pruned).toBe(0)
    expect(readRaw().entries.map((e) => e.detail)).toEqual(['刚好在窗内', '新'])
  })

  it('窗宽 = 2 日（**常量**；不随任何配置变化 ⇒「这个时间是程序化的」）', () => {
    expect(CRO_LOG_RETENTION_MS).toBe(2 * DAY)
  })

  it('裁剪是**纯函数**：保留 / 裁剪 / 丢弃三分类可穷举', () => {
    const mk = (at: string, detail: string): CroWakeLogEntry => ({
      at,
      ok: true,
      detail,
      tick: 0,
      reason: null,
      promptDigest: { length: 0, head: '' },
    })
    const inWin = mk(new Date(NOW - DAY).toISOString(), 'win')
    const outWin = mk(new Date(NOW - 3 * DAY).toISOString(), 'out')
    const broken = mk('不是时间', 'broken')
    const r = pruneCroLogEntries([inWin, outWin, broken], NOW)
    expect(r.kept.map((e) => e.detail)).toEqual(['win'])
    expect(r.pruned).toBe(1)
    expect(r.dropped).toBe(1) // 不可解析 ⇒ 丢弃**并报数**（不静默吞）
  })

  it('🔴 长期运行不无界增长（模拟 30 天 × 40min 心跳，逐条写入）', () => {
    const step = 40 * 60 * 1000
    for (let t = NOW - 30 * DAY; t <= NOW; t += step) {
      appendCroWakeLog(root, DIR, { ok: true, detail: 'x', tick: 0, reason: null }, t)
    }
    const n = readRaw().entries.length
    expect(n).toBeLessThanOrEqual(Math.ceil(CRO_LOG_RETENTION_MS / step) + 1) // 有界
    expect(n).toBeGreaterThan(60) // 但确实保留了"两日"的量（36 条/天 × 2）
  })
})

describe('🔴 绝不抛（铁律：写流水的问题不得影响投递与既有链路）', () => {
  it('坏档（半行乱码）⇒ 不 throw；坏行被跳过、好行照读，且之后仍能追加', () => {
    writeRaw('# 表头\n这是半行乱码\n2026-09-20T08:00:00+08:00\tok\ttick=7\t好行\treason=\tprompt=0:\n')
    const loaded = loadCroWakeLog(root, DIR)
    expect(loaded.error).toBeNull() // 纯文本的坏行**不是**整档失败
    expect(loaded.log.entries.map((e) => e.detail)).toEqual(['好行'])
    expect(appendCroWakeLog(root, DIR, { ok: true, detail: 'after-corrupt', tick: 1, reason: null }, NOW).ok).toBe(true)
    expect(readRaw().entries.map((e) => e.detail)).toEqual(['好行', 'after-corrupt'])
  })

  it('落点父目录不可建（AGENT_SESSIONS 被占成普通文件）⇒ 返回失败，不 throw', () => {
    const parent = join(root, 'AGENT_SESSIONS')
    writeFileSync(parent, 'not-a-dir', 'utf-8')
    const res = appendCroWakeLog(root, DIR, { ok: true, detail: 'x', tick: 1, reason: null }, NOW)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('写入失败')
  })

  it('原子写：写完成后不留 `.tmp` 残留', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: 'x', tick: 1, reason: null }, NOW)
    expect(existsSync(`${croWakeLogPath(root, DIR)}.tmp`)).toBe(false)
  })
})

describe('🔴 分工边界：这是"投递面"，不是第二真相源', () => {
  it('条目**只含投递面字段**，不夹带判定细节', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: '已投递（冷载入）', tick: 9, reason: '心跳', prompt: 'x' }, NOW)
    expect(Object.keys(readRaw().entries[0]!).sort()).toEqual(['at', 'detail', 'ok', 'promptDigest', 'reason', 'tick'])
    const flat = readRaw().text
    for (const forbidden of ['lastDecision', 'lastRunAt', 'threshold', 'MIN_INTERVAL', 'predicate', 'category']) {
      expect(flat).not.toContain(forbidden)
    }
  })

  it('提示词只留**摘要**（长度 + 前 N 字），不搬全文', () => {
    appendCroWakeLog(root, DIR, { ok: true, detail: 'd', tick: 1, reason: null, prompt: 'x'.repeat(500) }, NOW)
    const d = readRaw().entries[0]!.promptDigest
    expect(d.length).toBe(500)
    expect(d.head).toHaveLength(CRO_PROMPT_HEAD_MAX)
  })
})

describe('summarizeCroPrompt（纯函数边界）', () => {
  it('undefined / 空串 ⇒ 长度 0、摘要空（不抛）', () => {
    expect(summarizeCroPrompt(undefined)).toEqual({ length: 0, head: '' })
    expect(summarizeCroPrompt('')).toEqual({ length: 0, head: '' })
  })

  it('按**码点**计数（emoji / 中文不被切半）', () => {
    const s = '😀中文abc'
    expect(summarizeCroPrompt(s)).toEqual({ length: 6, head: s })
  })

  it('超长 ⇒ head 截到上限，length 仍报**全量**（长度本身就是信号）', () => {
    const r = summarizeCroPrompt('中'.repeat(200))
    expect(r.length).toBe(200)
    expect([...r.head].length).toBe(CRO_PROMPT_HEAD_MAX)
  })
})

