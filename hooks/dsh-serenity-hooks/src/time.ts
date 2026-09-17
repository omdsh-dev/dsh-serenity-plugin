/**
 * time.ts — ACC **时间呈现的单一真相源**（S142 2026-09-17，所有者令：「统一 ACC 所有使用时间的地方使用当地时区」）
 *
 * ── 存在的理由：**把"时刻"与"呈现"分开**（R↓）
 *
 *  · **时刻（instant）** = epoch 毫秒（`Date.now()`）—— **与时区无关**。
 *    比较 / 差值 / TTL / 调度 / TOTP 一律照旧，**不得"本地化"**：
 *    把时刻换成"当地钟面"会让它**不可比**（跨偏移、跨夏令时都会错）。
 *  · **呈现（rendition）** = 给人看、或存给人看的字符串 —— **一律当地时区 + 显式偏移**，
 *    如 `2026-09-17T17:20:00.123+08:00`。
 *    ⚠️ **偏移不能省**（这是本模块最容易被"简化"掉的一点）：省了就丢掉"这是哪一刻"，
 *    而且**跨格式的字符串排序会错**（`...T09:00:00Z` 与 `...T17:00:00+08:00` 是同一刻，
 *    字典序却相反）。带偏移的 RFC3339 **同时**满足"当地钟面"与"可解析、可比较"。
 *  · **当地** = 运行机器的本地时区（node 在 `Asia/Shanghai` 即 `+08:00`）—— **不硬编码时区名**，
 *    否则换机器/换地区就错。偏移**按被格式化的那个时刻求**（`getTimezoneOffset` 随夏令时变化）。
 *
 * ── 用法边界（本模块**只**做呈现；不做时刻运算）
 *   ✅ `isoLocal()` / `localDate()` / `localDateTime()` / `localHuman()` / `localFileStamp()`
 *   ❌ 不要用它们做排序/比较/差值 —— 那些用 `Date.now()` / `Date.parse()` / epoch 运算。
 *
 * 出处：所有者 2026-09-17 令（统一当地时区 + 注入消息带当前时间）；设计判据见 S142 §0r。
 */

/** 两位补零（超两位按原样，用于毫秒 3 位） */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/**
 * 该**时刻**的 UTC 偏移（`+08:00` / `-05:00`）。
 * ⚠️ 必须传入要格式化的那个 date —— 偏移随夏令时变化，不能"取当前的偏移去格式化另一个时刻"。
 */
export function tzOffset(date: Date = new Date()): string {
  const minutesEast = -date.getTimezoneOffset() // getTimezoneOffset 是"UTC 减本地"，取负得到东为正
  const sign = minutesEast >= 0 ? '+' : '-'
  const abs = Math.abs(minutesEast)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 归一成 Date（接受 Date 或 epoch 毫秒） */
function toDate(value: Date | number = Date.now()): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * **RFC3339 当地时区**（带毫秒与偏移）：`2026-09-17T17:20:00.123+08:00`。
 * 存储与会话间交换的**默认呈现**（可被 `Date.parse` 原样解析回同一时刻）。
 */
export function isoLocal(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    tzOffset(d)
  )
}

/** 当地日期 `YYYY-MM-DD`（目录名/日期前缀） */
export function localDate(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当地 `YYYY-MM-DD HH:mm:ss`（人读；**不带偏移**，只用于已经明确"是本地时间"的展示位） */
export function localDateTime(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 当地 `YYYY-MM-DD HH:mm`（人读，到分钟） */
export function localDateTimeMinutes(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * **人读 + 偏移**：`2026-09-17 17:20:00 +08:00`。
 * 给"注入给 agent 的文本"用 —— 既要一眼看懂当地钟面，又不丢"这是哪一刻"。
 */
export function localHuman(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${localDateTime(d)} ${tzOffset(d)}`
}

/**
 * 文件名/ID 用的紧凑当地戳：`2026-09-17T172000`（可排序、无冒号/点，跨平台安全）。
 * 与 CCC 的文件命名底线一致（`<ISO8601 本地>-<短随机>`）。
 */
export function localFileStamp(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${localDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 唤醒条目 id 的当地戳部分：`YYYYMMDD-HHmm`（`w-<stamp>-<hex>`） */
export function localIdStamp(value: Date | number = Date.now()): string {
  const d = toDate(value)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
