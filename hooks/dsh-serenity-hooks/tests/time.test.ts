/**
 * time.test.ts — 时间呈现单一真相源的镜像测试（S142 2026-09-17）
 *
 * 守两件事（这是本模块存在的全部理由，见 `src/time.ts` 头部）：
 *  ① **呈现带显式偏移**，且偏移**取自被格式化的那个时刻**（不是"当前偏移"）；
 *  ② **呈现可解析回同一时刻**（不丢信息）且**同偏移下字典序 = 时间序**（可排序）。
 * 反向不变量：本模块**不做时刻运算** —— 测试里所有比较都回到 epoch 毫秒。
 */

import { describe, it, expect } from 'vitest'
import {
  tzOffset,
  isoLocal,
  localDate,
  localDateTime,
  localDateTimeMinutes,
  localHuman,
  localFileStamp,
  localIdStamp,
} from '../src/time.js'

const OFFSET_RE = /^[+-]\d{2}:\d{2}$/

describe('time: 偏移（呈现必须带，且随时刻求）', () => {
  it('tzOffset 形状为 ±HH:MM', () => {
    expect(tzOffset()).toMatch(OFFSET_RE)
  })

  it('偏移由**传入时刻**决定（getTimezoneOffset 取负，东为正）', () => {
    const d = new Date('2026-09-17T09:20:00Z')
    const minutesEast = -d.getTimezoneOffset()
    const sign = minutesEast >= 0 ? '+' : '-'
    const abs = Math.abs(minutesEast)
    const expected = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(tzOffset(d)).toBe(expected)
  })

  it('同偏移体系下，字典序 = 时间序（带偏移的 RFC3339 才有的性质）', () => {
    const times = [
      '2026-09-17T08:00:00.000Z',
      '2026-09-17T01:30:00.000Z',
      '2026-09-16T23:59:59.999Z',
      '2026-09-17T12:00:00.000Z',
    ].map((s) => Date.parse(s))
    const rendered = times.map((t) => isoLocal(t))
    const byString = [...rendered].sort()
    const byTime = [...times].sort((a, b) => a - b).map((t) => isoLocal(t))
    expect(byString).toEqual(byTime)
  })
})

describe('time: 呈现不丢信息（可解析回同一时刻）', () => {
  it('isoLocal 往返 Date.parse 一致（含毫秒）', () => {
    for (const ms of [Date.now(), 0, 1_789_000_000_123, 1_700_000_000_001]) {
      expect(Date.parse(isoLocal(ms))).toBe(ms)
    }
  })

  it('isoLocal 以偏移结尾（**不是** Z），且含毫秒三位', () => {
    const s = isoLocal(Date.parse('2026-09-17T09:20:00.123Z'))
    expect(s).not.toMatch(/Z$/)
    // 整串形态：日期 T 时间 .毫秒 偏移（注意 OFFSET_RE 带 ^$ 锚，只能整串用，不能当子串判据）
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    expect(s.endsWith(tzOffset(new Date(Date.parse('2026-09-17T09:20:00.123Z'))))).toBe(true)
  })

  it('Date 与 epoch 毫秒两种入参等价', () => {
    const d = new Date(1_789_000_000_123)
    expect(isoLocal(d)).toBe(isoLocal(d.getTime()))
  })

  it('缺省入参 = 现在（近似断言）', () => {
    const before = Date.now()
    const parsed = Date.parse(isoLocal())
    const after = Date.now()
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(after)
  })
})

describe('time: 各呈现形态的形状与一致性', () => {
  const t = Date.parse('2026-09-17T09:20:00.123Z')
  const d = new Date(t)
  const p2 = (n: number): string => String(n).padStart(2, '0')

  it('localDate = 当地 YYYY-MM-DD（用当地 getter，不是 UTC）', () => {
    expect(localDate(t)).toBe(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
  })

  it('localDateTime / localDateTimeMinutes 形态正确且前缀同 localDate', () => {
    expect(localDateTime(t)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(localDateTimeMinutes(t)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(localDateTime(t).startsWith(localDate(t))).toBe(true)
    expect(localDateTime(t).startsWith(localDateTimeMinutes(t))).toBe(true)
  })

  it('localHuman = 当地钟面 + 偏移（两者都在）', () => {
    const s = localHuman(t)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/)
    expect(s).toContain(tzOffset(d))
    expect(s.startsWith(localDateTime(t))).toBe(true)
  })

  it('localFileStamp 无冒号/点（跨平台安全）且可排序', () => {
    expect(localFileStamp(t)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}$/)
    const a = localFileStamp(Date.parse('2026-09-17T01:00:00Z'))
    const b = localFileStamp(Date.parse('2026-09-17T02:00:00Z'))
    expect(a < b).toBe(true)
  })

  it('localIdStamp = YYYYMMDD-HHmm（唤醒 id 用）', () => {
    const s = localIdStamp(t)
    expect(s).toMatch(/^\d{8}-\d{4}$/)
    expect(s.slice(0, 8)).toBe(localDate(t).replace(/-/g, ''))
    expect(s.slice(9)).toBe(`${p2(d.getHours())}${p2(d.getMinutes())}`)
  })
})
