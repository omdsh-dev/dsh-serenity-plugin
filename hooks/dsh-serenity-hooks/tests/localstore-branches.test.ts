/**
 * localstore-branches.test.ts — 🔴 **⑤ 第 66 件**：`src/localstore-ops.ts` 的
 * **`runLocalStore` 拒绝面 ＋ `unset` 动作 ＋ 归一与降级臂**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（01:1x 那一跑，第 65 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `localstore-ops.ts`（**84.84% = 84/99**；语句 97.48% = 310/318；
 * 函数 16/16 已满）。
 * 🔴 **成对读（纪律 16）本次拦下一处**：85.5% 那处是 `trajectory-skills.ts`（line 823），
 * 高于本件 ⇒ 本轮取更低者。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯）
 * grep `localstore-ops.js` 的 import 点 ＋ 全部导出名 ⇒ 命中 `localstore.test.ts`（187 行，专测）
 * 与 `localstore.test.ts`（CCC 侧 `tests/` 下的另一套，测 acc-localstore 工具）。
 * 既有 `hooks/.../localstore.test.ts` 已覆盖：**路径与文件名**／**gitTrack 缺省 deny 与显式 allow**／
 * **isLocalstoreGitignored 的行判定（注释/空行不算）**／**ensure 的追加与幂等**／
 * **checkCompliance 四态**／**JSON 顶层分节**／**坏 JSON 视为空**／**credential 与 config 往返**／
 * **key 与 path 校验各一例**／**runLocalStore 的 doc/list/get/set/show 正路** ⇒ 本件**不重做**其中任何一条。
 *
 * ## 🔵 缺口形态：`runLocalStore` 的**整套拒绝面** ＋ 整个 `unset` 动作**从未被执行**
 * 既有用例调用 `runLocalStore` **只走正路**（每次都提供 `name`／`value`），且**从不调 `unset`** ⇒
 * 五条 `requires ...` 守卫、`not found` 分支、`case 'unset'` 整块、`default` 未知子命令**全部零执行**。
 * 🔴 **而它们恰是"用户敲错命令时要响亮报错、而不是静默做错事"的唯一执行点** ——
 * 把某条 `throw` 误删或条件写反（例如 `!args.value` 误写成 `args.value === null`），
 * **既有全部测试仍绿**，而现网表现为**静默写入空值**或**静默什么都不做**。
 *
 * ## 🔴 本件为何要紧（objective 直指"长期存活"）
 * `unset` 是**唯一删除凭据的入口**：它的 `removed` 布尔是调用方判断"到底删没删"的**唯一信号**
 * ⇒ 若它恒返回 `true`（写反成 `return true`），运维会**以为凭据已撤销**而实际仍在盘上 ——
 * 这是**安全意义上的静默失败**，属本容器反复栽的"安静失败"一族。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：每条拒绝都配"给对了参数必须放行"的对照。
 * · **⑱ 测"可选字段缺省"用 `'key' in obj` 而非 `toBeUndefined()`** ⇒ 见 `git` 键那条。
 * · **判据钉盘上事实**：删没删看**磁盘上的 JSON**，不看返回值自述。
 * · **⑧ 不声称一个我没挣到的覆盖**：`:121` 的 `?? err` 右侧需 catch 抛**非 Error** ⇒ 见「诚实边界」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  localstorePath,
  runLocalStore,
  unsetEntry,
  writeEntry,
  getEntry,
  checkLocalstoreGitCompliance,
} from '../src/localstore-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'localstore-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 读**磁盘**上的档（判据 = 实际内容，不是返回值自述）；档不存在 ⇒ 空档 */
function readRaw(): Record<string, Record<string, string>> {
  // 🔴 档不存在**必须**当空档（不是崩）：本文件的判据含「拒绝后盘上不该有副作用」，
  //    而"连文件都没建出来"正是**最强的无副作用形态** ⇒ 不能因 ENOENT 反而测不成。
  if (!existsSync(localstorePath(dir))) return {}
  return JSON.parse(readFileSync(localstorePath(dir), 'utf-8')) as Record<string, Record<string, string>>
}

/** 把 CCC 配成 allow（用于需要"非 deny"形态的对照） */
function setAllow(): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
}

describe('localstore 退化面：`runLocalStore` 的**拒绝面**（用户敲错要响亮报错）', () => {
  it('🟢 正控（夹具自证）：五个动作各自的正路都必须走通（否则下面每条"拒绝"都不可判）', () => {
    // 🔴 先证明夹具不瞎（纪律 10）：同一夹具下正路必须成功
    expect(runLocalStore(dir, { action: 'set', name: 'K1', value: 'v1' })).toMatchObject({ set: true })
    expect(runLocalStore(dir, { action: 'get', name: 'K1' })).toMatchObject({ value: 'v1' })
    expect(runLocalStore(dir, { action: 'list' })).toMatchObject({ keys: ['K1'] })
    expect(runLocalStore(dir, { action: 'show', name: 'K1' })).toMatchObject({ exists: true })
    expect(runLocalStore(dir, { action: 'unset', name: 'K1' })).toMatchObject({ removed: true })
    expect(runLocalStore(dir, { action: 'doc' })).toHaveProperty('doc')
  })

  it('🔴 `:287` `get` 缺 name ⇒ 抛 `get requires name`（**不得**静默回 null）', () => {
    expect(() => runLocalStore(dir, { action: 'get' })).toThrow(/get requires name/)
    // 负控：给了 name 就必须放行（区分"守卫生效"与"这个动作坏了"）
    writeEntry(dir, 'credential', 'OK_KEY', 'v')
    expect(runLocalStore(dir, { action: 'get', name: 'OK_KEY' })).toMatchObject({ value: 'v' })
  })

  it('🔴 `:293` `set` 缺 name ⇒ 抛；`:294` 给了 name 但**缺 value** ⇒ 抛 `set requires value`', () => {
    expect(() => runLocalStore(dir, { action: 'set', value: 'v' })).toThrow(/set requires name/)
    expect(() => runLocalStore(dir, { action: 'set', name: 'K' })).toThrow(/set requires value/)
    // 🔴 最要紧的负控：**拒绝不得留下副作用** —— 盘上不该出现那个 key
    // （若 `:294` 写反成 `!args.value`，空串会被当"缺 value"拒掉；反之若删掉守卫，
    //   会写入 undefined ⇒ 这里用"盘上没有该键"作判据最稳）
    expect(readRaw().credentials ?? {}).not.toHaveProperty('K')

    // 边界正控：**空串是合法值**（`args.value === undefined` 才是缺）⇒ 空串必须放行
    expect(runLocalStore(dir, { action: 'set', name: 'EMPTY_OK', value: '' })).toMatchObject({ set: true })
    expect(getEntry(dir, 'credential', 'EMPTY_OK'), '空串必须被真的写进去（不是"缺 value"）').toBe('')
  })

  it('🔴 `:304` `unset` 缺 name ⇒ 抛 `unset requires name`（**不得**静默不删）', () => {
    expect(() => runLocalStore(dir, { action: 'unset' })).toThrow(/unset requires name/)
  })

  it('🔴 `:309` `show` 缺 name ⇒ 抛 `show requires name`', () => {
    expect(() => runLocalStore(dir, { action: 'show' })).toThrow(/show requires name/)
  })

  it('🔴 `:289` `get` **查不到** ⇒ 抛 `not found`（带 name 与 scope，便于用户自查）', () => {
    expect(() => runLocalStore(dir, { action: 'get', name: 'NO_SUCH_KEY' })).toThrow(/not found: NO_SUCH_KEY/)
    // 🔴 对照 `show`：**同样是"没有"，但语义不同** ——
    // `show` 是"看看在不在"（返回 exists:false，**不抛**），`get` 是"我要值"（**抛**）
    // ⇒ 只测一条无法区分"两件事被写成了一样"
    expect(runLocalStore(dir, { action: 'show', name: 'NO_SUCH_KEY' })).toMatchObject({ exists: false })
  })

  it('🔴 `:315` **未知子命令** ⇒ 抛，且报错里列出可用动作（可自查）', () => {
    const err = (() => {
      try {
        runLocalStore(dir, { action: 'no-such-action' })
        return null
      } catch (e) {
        return String((e as Error).message)
      }
    })()
    expect(err, '未知动作必须抛').not.toBeNull()
    expect(err).toContain('Unknown subcommand: no-such-action')
    // 判据：报错必须**自含可用清单**（否则用户只能去读源码）
    for (const a of ['list', 'get', 'set', 'unset', 'show', 'doc']) {
      expect(err, `报错应列出可用动作 ${a}`).toContain(a)
    }
  })
})

describe('localstore 退化面：`unset` 动作语义（**唯一删除凭据的入口**）', () => {
  it('🔴 `:303` `unset` 整块：真删掉 ⇒ `removed:true`，且**盘上确实没了**', () => {
    writeEntry(dir, 'credential', 'TO_DELETE', 'v')
    const r = runLocalStore(dir, { action: 'unset', name: 'TO_DELETE' }) as { removed: boolean; name: string }
    expect(r.removed, '删掉了必须报 true').toBe(true)
    expect(r.name).toBe('TO_DELETE')
    // 🔴 **判据钉盘上事实**（不看返回值自述）：creds 节里确实没有这个键了
    expect(readRaw().credentials ?? {}).not.toHaveProperty('TO_DELETE')
  })

  it('🔴 `unset` 一个**不存在**的 key ⇒ `removed:false`（**不得**谎报 true）', () => {
    // 🔴 这是本组最要紧的判据：`removed` 是调用方判断"到底删没删"的**唯一信号**
    // ⇒ 若写反成恒 `true`，运维会**以为凭据已撤销**而实际仍在盘上（安全意义的静默失败）
    writeEntry(dir, 'credential', 'SURVIVOR', 'v')
    const r = runLocalStore(dir, { action: 'unset', name: 'GHOST_KEY' }) as { removed: boolean }
    expect(r.removed, '没这个东西 ⇒ 必须如实报 false').toBe(false)
    expect(getEntry(dir, 'credential', 'SURVIVOR'), '拒绝不得误伤别的键').toBe('v')
  })

  it('🔴 `unset` config 侧同样两向：删得到 ⇒ true；`:193` **节里没有该 key** ⇒ false', () => {
    writeEntry(dir, 'config', 'ui.theme', 'dark')
    writeEntry(dir, 'config', 'ui.size', 'big')
    expect((runLocalStore(dir, { action: 'unset', name: 'ui.theme', scope: 'config' }) as { removed: boolean }).removed).toBe(true)
    // `:193` 的 `!sec || !(key in sec)` 两形态都要走到：
    //   ① 节还在、但 key 不在 ② **节整个不存在**
    expect((runLocalStore(dir, { action: 'unset', name: 'ui.nope', scope: 'config' }) as { removed: boolean }).removed).toBe(false)
    expect((runLocalStore(dir, { action: 'unset', name: 'nosuch.key', scope: 'config' }) as { removed: boolean }).removed,
      '节整个不存在 ⇒ 同样 false（`!sec` 那一侧）').toBe(false)
    expect(getEntry(dir, 'config', 'ui.size'), '两次 false 都不得误伤').toBe('big')
  })

  it('🔴 `unsetEntry` 直调：**空节自动移除**（不留 `{}` 空壳）', () => {
    writeEntry(dir, 'credential', 'ONLY_ONE', 'v')
    writeEntry(dir, 'config', 'solo.k', 'v')
    expect(readRaw()).toHaveProperty('credentials')
    unsetEntry(dir, 'credential', 'ONLY_ONE')
    expect(readRaw(), 'credential 节空了 ⇒ 整节移除').not.toHaveProperty('credentials')
    unsetEntry(dir, 'config', 'solo.k')
    expect(readRaw(), 'config 节空了 ⇒ 整节移除').not.toHaveProperty('solo')
    // 🔴 反方向：**非空节不得被误删**（只测"空了就删"无法区分"总是删"）
    writeEntry(dir, 'credential', 'A', '1')
    writeEntry(dir, 'credential', 'B', '2')
    unsetEntry(dir, 'credential', 'A')
    expect(readRaw().credentials, '还剩一个 ⇒ 节必须留着').toEqual({ B: '2' })
  })
})

describe('localstore 退化面：scope 归一与 `git` 键形态', () => {
  it('🔴 `:282` scope **归一**：只有 `"config"` 走 config，**其余一切**（含 undefined/乱写）都归 credential', () => {
    // 🔴 这是"默认命名空间"的唯一执行点：写反 ⇒ 凭据被写进 config 节（安全意义的错放）
    writeEntry(dir, 'credential', 'SECRET_A', 'v')
    writeEntry(dir, 'config', 'ui.theme', 'dark')

    // ① 显式 config ⇒ 读 config
    expect(runLocalStore(dir, { action: 'list', scope: 'config' }) as unknown).toMatchObject({ scope: 'config' })
    // ② 不给 scope ⇒ credential
    expect(runLocalStore(dir, { action: 'list' }) as unknown).toMatchObject({ scope: 'credential' })
    // ③ 乱写 scope ⇒ **仍归 credential**（不是"报错"、更不是"落到 config"）
    expect(runLocalStore(dir, { action: 'list', scope: 'nonsense' }) as unknown).toMatchObject({ scope: 'credential' })
    // ④ 大小写不同也算"不是 config"（判据是严格等值）
    expect(runLocalStore(dir, { action: 'list', scope: 'CONFIG' }) as unknown).toMatchObject({ scope: 'credential' })

    // 负控：归一后**取的内容**必须与 scope 一致（只看回显字段是弱断言）
    expect((runLocalStore(dir, { action: 'list' }) as { keys: string[] }).keys).toEqual(['SECRET_A'])
    expect((runLocalStore(dir, { action: 'list', scope: 'config' }) as { keys: string[] }).keys).toEqual(['ui.theme'])
  })

  it('🔴 `:300` `git` 键恒在场；`:296` 的 warning 侧**经 `set` 构造上不可达**（如实登记）', () => {
    // 🔴 判据用 `'git' in obj`（纪律 ⑱）：契约是**键恒在场**（值为 null 或对象），
    //    用 `toBeUndefined()` 对「无该键」与「键值为 undefined」都绿 ⇒ 弱断言
    const ok = runLocalStore(dir, { action: 'set', name: 'K', value: 'v' }) as Record<string, unknown>
    expect('git' in ok, '合规时该键必须在场（值为 null）').toBe(true)
    expect(ok.git, 'deny+已 gitignore ⇒ 合规 ⇒ 无 warning').toBeNull()

    // 🔴🔴 诚实边界（**首跑红逼出的取证结论，不是遗漏**）：`:296` 的 `checkLocalstoreGitCompliance`
    //    **排在 `writeEntry` 之后**，而 `writeEntry` 内部就调 `ensureLocalstoreGitignored`
    //    ⇒ **只要经 `set` 走到这里，.gitignore 必然刚被补齐 ⇒ 恒合规 ⇒ `git.reason` 恒 undefined**
    //    ⇒ 我原写的"先删 gitignore 行、再 set ⇒ 带 warning" **结构上不可达**
    //    （首跑实测 `expected null to match object {warning}`：那次 `set` 把删掉的行**又加回来了**）。
    //    ⇒ 按纪律 ⑧：**不声称一个我没挣到的覆盖** ⇒ 改为钉住两条**真能被钉住**的事实：
    //    ① 经 `set` 永远得到 `null`（上面那两条断言即是）
    //    ② 若要拿到 warning，**必须绕过 `set`、直调合规检查**（下面这条）——这才是该函数真实的调用面。
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n') // 手删（题设的真实事故形态）
    const direct = checkLocalstoreGitCompliance(dir)
    expect(direct.ok, '手删 .gitignore 行后 ⇒ 不合规').toBe(false)
    expect(direct.reason, '不合规必须给可读原因（不得静默）').toContain('localstore.json')
  })

  it('🔴 `:94`/`:98` `checkLocalstoreGitCompliance` 的 **allow 短路**：置 allow ⇒ 即便未 gitignore 也放行', () => {
    // 既有用例测的是"无文件/已覆盖/未覆盖"三态；**allow 那一条在"文件存在且未覆盖"下**未测
    writeEntry(dir, 'credential', 'K', 'v')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n') // 人为造成"未覆盖"
    expect(runLocalStore(dir, { action: 'set', name: 'K2', value: 'v' }) as unknown).toMatchObject({ gitTrack: 'deny' })
    setAllow()
    const r = runLocalStore(dir, { action: 'set', name: 'K3', value: 'v' }) as { gitOk: boolean; gitTrack: string }
    expect(r.gitTrack).toBe('allow')
    expect(r.gitOk, 'allow ⇒ 即使 .gitignore 没覆盖也必须放行（放行是显式意图）').toBe(true)
    expect((r as unknown as Record<string, unknown>).git).toBeNull()
  })
})

describe('localstore 退化面：`.gitignore` 写入的两个分支（`:79`/`:84`）', () => {
  it('🔴 既有 `.gitignore` **不以换行结尾** ⇒ 追加前必须补一个换行（不得与上一行粘连）', () => {
    // 🔴 这是"追加一行"这条承诺的**唯一执行点**：漏了补换行 ⇒ 生成
    //    `node_modules/localstore.json  # …` —— **两条规则被粘成一条**，
    //    结果 node_modules 规则失效、localstore 规则也不生效 ⇒ **静默失效**。
    writeFileSync(join(dir, '.gitignore'), 'node_modules/') // ⚠️ 故意**不给**尾换行
    writeEntry(dir, 'credential', 'K', 'v')
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gi.split('\n')[0], '上一行必须保持完整（未被拼接）').toBe('node_modules/')
    expect(gi.split('\n').filter((l) => l.includes('node_modules')).length, 'node_modules 行不得被粘连').toBe(1)
    expect(gi.includes('localstore.json'), 'localstore 规则必须真的落上').toBe(true)
  })

  it('🔴 既有 `.gitignore` **为空文件** ⇒ 不得以空行开头（`:84` 的 existing 为空串那一侧）', () => {
    writeFileSync(join(dir, '.gitignore'), '')
    writeEntry(dir, 'credential', 'K', 'v')
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gi.startsWith('localstore.json'), '空档 ⇒ 首行就是规则，不得有前导空行').toBe(true)
    expect(gi.endsWith('\n'), '必须补尾换行').toBe(true)
  })

  it('🔴 对照：**以换行结尾**的既有档 ⇒ 直接追加（不得多加空行）', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    writeEntry(dir, 'credential', 'K', 'v')
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gi.startsWith('node_modules/\nlocalstore.json'), '不得插入多余空行').toBe(true)
    expect(gi.includes('\n\n'), '不得出现空行').toBe(false)
  })
})

describe('localstore 退化面：config path 校验的**三段**（既有用例只打到两段）', () => {
  it('🔴 `:156` **节名非法**（大写/下划线/数字开头）⇒ 抛 section 规范错', () => {
    // 🔴 既有用例只测了 `badpath`（无点）与 `handyman.BadKey`（key 非法）
    // ⇒ **节名那一条守卫（`:156`）从未被执行**：把 `.test(section)` 误删，
    //    用户能建出 `Bad-Section.key` 这种节名，而既有测试全绿
    for (const bad of ['BadSection.k', 'with_underscore.k', '9num.k']) {
      expect(() => writeEntry(dir, 'config', bad, 'v'), `${bad} 的节名必须被拒`).toThrow(/config section/)
    }
    // 负控方向：合法的节名（小写字母开头 + 数字/连字符）必须放行
    expect(() => writeEntry(dir, 'config', 'good-section.k', 'v')).not.toThrow()
    expect(getEntry(dir, 'config', 'good-section.k')).toBe('v')
  })

  it('🔴 `:151` config path **边角形态**：以点开头 / 以点结尾 / 前后都有点', () => {
    // `idx <= 0` 覆盖"以点开头"与"无点"；`idx === path.length - 1` 覆盖"以点结尾"
    for (const bad of ['.k', 'sec.', '.']) {
      expect(() => writeEntry(dir, 'config', bad, 'v'), `${bad} 必须被拒`).toThrow(/must be section\.key/)
    }
  })
})

describe('localstore 退化面：`readAll` 的**合法对象**闸与告警去重', () => {
  it('🔴 `:115` 顶层**是对象但不是分节形状**（值非对象）⇒ 闸**只判顶层形状**、值形状不管', () => {
    // 🔴 `readAll` 的判据是「非 null 对象 ∧ 非数组」，**不校验值是不是对象**
    // ⇒ `{"credentials": "not-an-object"}` 会被**原样返回**（不抛、不归一）
    writeFileSync(localstorePath(dir), JSON.stringify({ credentials: 'oops', ui: 42 }), 'utf-8')
    // 🔴🔴 诚实边界（**首跑红逼出的取证结论**）：`readStore` 的兜底是 `?? {}`，而
    //    **`'oops'` 不是 nullish ⇒ 兜不住** ⇒ `Object.keys('oops')` 得到**字符索引**
    //    `['0','1','2','3']`。我原断言 `keys: []` 是**错的**（把"值非对象"误当成"会被归一成空"）。
    //    ⇒ 这里钉**真实行为**（既不断言 [] 、也不声称它被兜住），并把"闸管什么"钉死：
    //    ① 顶层形状由 `:115` 把关；② **值形状无人把关**（这是设计边界，不是本件的修复对象）。
    expect(runLocalStore(dir, { action: 'list' })).toMatchObject({ keys: ['0', '1', '2', '3'] })
    // 对照：顶层形状**坏**的对象才被 `:115` 拦到空档（与上面"值坏但顶层好"成对，纪律 ⑬）
    writeFileSync(localstorePath(dir), JSON.stringify({ credentials: { OK: 'v' } }), 'utf-8')
    expect(runLocalStore(dir, { action: 'list' })).toMatchObject({ keys: ['OK'] })
    // 🔴 且**绝不抛** —— 值形状坏掉的档不得把工具面打崩（宽松继续是设计意图）
    writeFileSync(localstorePath(dir), JSON.stringify({ credentials: 'oops', ui: 42 }), 'utf-8')
    expect(() => runLocalStore(dir, { action: 'list', scope: 'config' })).not.toThrow()
  })

  it('🔴 `:116` 顶层是**裸数组 / 裸字面量** ⇒ 回退空档（不是崩溃）', () => {
    for (const body of ['[1,2,3]', '42', '"str"', 'null']) {
      writeFileSync(localstorePath(dir), body, 'utf-8')
      expect(runLocalStore(dir, { action: 'list' }) as unknown, `顶层 ${body} ⇒ 当空档`).toMatchObject({ keys: [] })
      expect((runLocalStore(dir, { action: 'list', scope: 'config' }) as { keys: string[] }).keys).toEqual([])
    }
  })

  it('🔴 `:114` **BOM 剥除**回归钉：带 UTF-8 BOM 的档必须能读（不得整档判坏）', () => {
    // 真实形态：Windows 编辑器 / 某些工具写出的 JSON 会带 BOM
    // 若不剥 BOM ⇒ `JSON.parse` 抛 ⇒ **整份凭据被判"损坏"、表现成"未设置"**
    writeFileSync(localstorePath(dir), '\uFEFF' + JSON.stringify({ credentials: { BOM_KEY: 'v' } }), 'utf-8')
    expect(getEntry(dir, 'credential', 'BOM_KEY'), 'BOM 不得让整档失效').toBe('v')
  })

  it('🔴 坏 JSON 的**告警去重**（模块级状态）：同一路径只喊一次 ⇒ 判据是"第二次相对第一次未增加"', () => {
    // 🔴 纪律（第 51 件沉淀）：模块级「只喊一次」状态**跨用例存活** ⇒
    //    不能用"总数 ≥ 1"断言（首次可能一条都不打）；判据 = **第二次相对第一次"未增加"**。
    //    ⚠️ 且本文件用**全新 tmp 路径** ⇒ 该路径必然尚未进过 warnedBrokenStores。
    writeFileSync(localstorePath(dir), '{ 坏 JSON', 'utf-8')

    const calls: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => { calls.push(String(a[0])) }
    try {
      runLocalStore(dir, { action: 'list' })
      const afterFirst = calls.length
      runLocalStore(dir, { action: 'list' })
      const afterSecond = calls.length
      expect(afterFirst, '首次必须喊（坏凭据档不得静默）').toBe(1)
      expect(afterSecond, '第二次**不得**再喊（同一路径去重）').toBe(afterFirst)
    } finally {
      console.warn = orig
    }
    // 负控方向：坏档虽坏，工具层**不得抛**（宽松继续是设计意图）
    expect(() => runLocalStore(dir, { action: 'list' })).not.toThrow()
  })
})
