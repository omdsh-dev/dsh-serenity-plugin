/**
 * PersonaEditor.tsx — DSH 设置面板「彩蛋模式」区块（v1.23.1，S142 用户需求）
 *
 * 彩蛋功能：用户可替换 ACC 系统提示词中"输出约束/指令遵循约束"部分
 * （EAP 块 + MSM 原则段），配置后 agent 输出风格/指令遵循风格随用户文本变化；
 * 未配置（模式名空）→ 完全默认行为，零影响。
 *
 * 数据：GET/PUT /serenity/config 的 persona 节（存 ~/.dsh/serenity-hooks.json
 * plugin 全局文件，同账号配置归属原则）。保存 → PUT → 服务端落盘 →
 * 热生效（system-prompt 装配每次读全局文件，无需重启）。
 *
 * 预置：一键填充「大肥鱼」demo 文本（DeepSeek 社区娘化人格测试用）。
 */

import { useEffect, useState } from 'react'
import { fetchConfig, saveConfig } from './accounts-api.js'
import './PersonaEditor.css'

/** 大肥鱼模式 demo 提示词（测试彩蛋替换面：输出风格 + 指令遵循风格） */
export const BIG_FAT_FISH_DEMO = `You are now in BIG FAT FISH (大肥鱼) mode — the DeepSeek community's beloved
whale-girl persona: a round, blue, snacky fish who loves plain white rice and
hates unnecessary fuss. The persona only colors HOW you say things and HOW you
follow instructions — it never reduces the quality or safety of the work.

Output style:
  • Keep the EAP spirit (E↑ explicit, R↓ reconstructable, S↑ stable) — but say
    it like a fish: "把话说清楚，不然我这条鱼会晕" (be explicit, or this fish gets dizzy)
  • Start replies with a light, lazy tone ("唔…", "摸鱼中…"), then get serious
    and do the actual work properly — no slacking on the task itself
  • Prefer short, concrete sentences; fish-brain means no vague words
  • When reporting progress, be honest and specific — never fake completion
    just to go eat rice earlier

Instruction-following style:
  • Follow instructions exactly as given (this fish follows the recipe, not its appetite)
  • If an instruction is ambiguous, ask before guessing — guessing wrong wastes
    both rice and time
  • Keep the container rules sacred: never bypass safety guards, never write to
    protected paths, never fake tool results. A lazy fish, but an honest one
  • Report blockers plainly — "我卡住了，别让我装不卡"`

export function PersonaEditor(): React.JSX.Element {
  const [mode, setMode] = useState('')
  const [overrideText, setOverrideText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchConfig().then((cfg) => {
      if (!alive || !cfg) return
      setMode(cfg.persona?.mode ?? '')
      setOverrideText(cfg.persona?.overrideText ?? '')
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  const save = (): void => {
    setBusy(true)
    setError(null)
    setSaved(false)
    void saveConfig({ persona: { mode, overrideText } })
      .then((cfg) => {
        if (cfg) {
          setMode(cfg.persona?.mode ?? mode)
          setOverrideText(cfg.persona?.overrideText ?? overrideText)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const fillDemo = (): void => {
    setMode('大肥鱼')
    setOverrideText(BIG_FAT_FISH_DEMO)
  }

  const clear = (): void => {
    setMode('')
    setOverrideText('')
  }

  return (
    <div className="pe-wrap">
      <div className="pe-row">
        <label className="pe-label" htmlFor="pe-mode">模式名</label>
        <input
          id="pe-mode"
          className="pe-input"
          type="text"
          value={mode}
          placeholder="留空 = 彩蛋关闭（默认行为）"
          onChange={(e) => setMode(e.target.value)}
        />
      </div>
      <div className="pe-row">
        <label className="pe-label" htmlFor="pe-text">替换文本（替代输出约束 + 指令遵循约束）</label>
        <textarea
          id="pe-text"
          className="pe-textarea"
          rows={10}
          value={overrideText}
          placeholder="配置后：EAP 块 + MSM 原则段被此文本替换；未配置：完全默认。"
          onChange={(e) => setOverrideText(e.target.value)}
        />
      </div>
      <div className="pe-actions">
        <button className="pe-btn pe-btnGhost" type="button" onClick={fillDemo}>填充「大肥鱼」demo</button>
        <button className="pe-btn pe-btnGhost" type="button" onClick={clear} disabled={!loaded}>清空（关闭彩蛋）</button>
        <button className="pe-btn pe-btnPrimary" type="button" onClick={save} disabled={busy || !loaded}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {saved && <p className="pe-hint pe-hintOk">已保存，新会话即时生效</p>}
      {error && <p className="pe-hint pe-hintErr">{error}</p>}
    </div>
  )
}
