/**
 * `bench/verify.sh` 的**形状门**（v1.51.2）
 *
 * ## 为什么需要它（这条是踩出来的，不是想出来的）
 *
 * `bench/verify.sh` 是**判据脚本**，跑在 docker 容器里。它有语法错时**不一定当场炸**：
 *   · 轻则**整段判据被吃掉**（验收表少几条 ⇒ "没验"长得像"过了"）；
 *   · 重则 `check` 收错参数，报出的红绿与真实情况无关。
 * ⇒ 而发现它**只能靠跑一整轮容器**（_build_ 镜像 → up → turn → vpush → verify，分钟级）。
 *
 * 2026-09-29 实测两次：① 新增 V10~V15 时把**中文引号写成英文双引号**（`"照抄越界坐标"`），
 * 那会**截断外层双引号串**；② 同批写的 `check` 参数串错。两次都靠**临时**的 `bash -n` 探针才逮到
 * —— 而临时探针用完就删了，下次还得重写一遍。
 *
 * ⇒ 本文件把那个探针**固化**下来：它不验判据内容对不对（那要真容器），只验
 * **"这份脚本至少是一份合法脚本，且该有的判据 id 都在"**。这是能在**秒级**给出答案的那一档。
 *
 * 边界（别把它当"判据正确性"的证明）：`bash -n` **只做语法解析，不执行**；
 * id 在场也**不代表判据写对了**。本文件是**前置闸门**，不是替代品。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 仓库根：从本文件（hooks/dsh-serenity-hooks/tests/）上溯三级 */
const REPO = resolve(import.meta.dirname, '../../..')
const BENCH = resolve(REPO, 'bench')

/** 有 bash 才跑（本仓 CI 是 linux，但别让缺 bash 的环境**静默通过**） */
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0

describe('bench 脚本形状门', () => {
  it('benches 目录下的 .sh 都能通过 bash -n（语法解析）', () => {
    if (!hasBash) {
      // 🔴 缺读数器 ⇒ **如实报缺**，不静默跳过（判据纪律：读数器本身要先证明不瞎）
      throw new Error('本机没有 bash ⇒ 无法做语法门（这是**读数器缺失**，不是通过）')
    }
    const files = ['verify.sh', 'entrypoint.sh']
    for (const rel of files) {
      const p = resolve(BENCH, rel)
      expect(existsSync(p), `缺文件：bench/${rel}`).toBe(true)
      let stderr = ''
      try {
        execFileSync('bash', ['-n', p], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        const e = err as { stderr?: string; message?: string }
        stderr = String(e.stderr ?? e.message ?? '')
      }
      // 出错时把 bash 的原话带进断言消息（否则只看到 "expected '' to be ''"）
      expect(stderr, `bench/${rel} 语法错：\n${stderr}`).toBe('')
    }
  })

  it('v1.51.1/v1.51.2 新增判据的 id 都在，且判据正文引用了**实测形态**', () => {
    const src = readFileSync(resolve(BENCH, 'verify.sh'), 'utf-8')
    // ⚠️ 不能断言 id **唯一**：本文件刻意在 if/else 各分支里复用同一 id（同时刻只有一条分支会跑）。
    for (const id of ['V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16']) {
      expect(src, `缺判据 ${id}`).toMatch(new RegExp(`check\\s+${id}\\s+"`))
    }
    // 判据正文必须真的引用了从容器里**实测取回**的形态（写错就退化成"永远绿"）
    for (const needle of [
      '"name":"diagram"',      // 工具调用事件
      'mediaType":"image/png', // 图块附件
      '在绘图窗口外：box=',    // 越界报错文案
      '已降级落盘：',          // 降级分支文案
      'tool\\.call\\.toolview', // v1.51.2 客户端注册
    ]) {
      expect(src.replace(/\\\./g, '.'), `判据没引用实测形态：${needle}`).toContain(needle.replace(/\\/g, ''))
    }
  })
})
