# trajectory-assistant: Complete Modification Plan (v0.2)

> SESSION: S142 (2026-09-05)
> Status: **Draft for user review — no implementation until approved**
> Language: English (as required)
> Companion design: `docs/trajectory-assistant-design.md` (v0.1 conceptual)

---

## 0. Decisions locked by the user (2026-09-05)

| # | Topic | Ruling |
|---|-------|--------|
| D1 | Scope of the rename | **All dynamic prompt-injection layers** (runtime injections + anchoring + compact + autopilot; both wording and code) |
| D2 | Settlement review trigger | Only when work is **finished AND user-approved** — hard to detect automatically; **record as an open problem**, do not implement detection now |
| D3 | Naming token | **Unify on the new token** (the "after" form). Legacy/live sessions need **no back-compat** — old tokens are simply obsolete |
| D4 | Level granularity | SESSION = level. Long sessions cannot be auto-subdivided reliably → **not implemented** (recorded as open problem) |
| D5 | Experiment mechanics | **Not a heavyweight A/B experiment apparatus** — trajectory-assistant is an ACC built-in mechanism; language style is one built-in facet (config selectable, default = usable) |
| D6 | Settlement mechanism | **Yes** — IF the CCC has a standard SESSION-review/close ritual, the settlement view belongs to trajectory-assistant. Current ACC close/archive has no review summary → mechanism deferred; design the hook point |
| D7 | output-guard membership | **Included** in trajectory-assistant (supersedes v0.1's "keep separate" suggestion) — as the *boundary-guard* event of the level system (safety semantics unchanged, naming/organization only) |

Open problems (recorded, NOT implemented in this pass):
- **OP-1 (settlement trigger)**: "user approves the work" has no reliable machine signal today. Candidate future signals: user explicit confirmation in conversation / SESSION `close` with review notes / a future standard review ritual. Design keeps a hook point; no auto-detection.
- **OP-2 (long-SESSION subdivision)**: auto-subdividing a SESSION level by SESSION.md sections/targets is undecidable reliably. Future idea: derive sub-segments from SESSION.md `## 章节` when present; not implemented.

---

## 1. Guiding principle for every edit

> **Mechanics stay; text is reworded.** Every injection mechanism keeps its trigger,
> timing, gating, and behavioral contract exactly as-is. The change surface is:
> **prefix tokens, naming, tone/style, and the unifying framework label.**

What must NOT change (compatibility invariants):
- ACK protocol semantics: `recorded-{code}` / `skipped-{code}` response contract.
- Rebuild trigger logic, escalation counting, tool-promotion state machine.
- `[轨迹焦点]` (topPrompt) — CCC-defined content, structurally untouchable.
- `session_rebuild` tool behavior / parameter contract (`--summary` still required).
- Metaphor universe content (SHIP/VOYAGE/CREW) — unchanged, only *referenced* by the new wording.
- The `stripAckSuffix` regex target: rebuilt anchors still drop the acknowledge tail.

---

## 2. Unified naming

**trajectory-assistant** = the mechanism layer that injects guidance prompts at the right
moment during a SESSION (level) — the "navigation officer / assistance system" of the
Serenity starship. Metaphor stays the *environment* (the ship itself); trajectory-assistant
is the *guidance* (the pilot giving course cues at key moments).

### Token mapping

| Current (in the wild) | New unified token | Meaning | Category (level event) |
|---|---|---|---|
| `[TRAJECTORY-STEWARD]` | `[TRAJECTORY-ASSISTANT · CHECKPOINT]` | score sync reminder | L3 checkpoint |
| `[TRAJECTORY]` | `[TRAJECTORY-ASSISTANT · BOSS]` | context-pressure rebuild cue | L4 boss |
| `[TRAJECTORY-ESCALATED]` | `[TRAJECTORY-ASSISTANT · BOSS · MANDATORY]` | escalated rebuild (mandatory) | L4 boss escalation |
| `[TRAJECTORY-REBUILD]` | `[TRAJECTORY-ASSISTANT · REBUILD]` | rebuilt-conversation anchor header | rebuild |
| `[SERENITY OUTPUT GUARD]` | `[TRAJECTORY-ASSISTANT · BOUNDARY GUARD]` | sensitive-output rebuke | L5 guard |
| `first-anchor` | `tutorial` (concept); code name kept as `bootstrap` | opening tutorial | L1 tutorial |
| `[ACC]` identity seed | `[ACC]` **kept** (identity beacon, not a level event) | session-start/compact reinjection | L0 beacon |
| SESSION-KEEPER (legacy comments) | removed / TRAJECTORY-ASSISTANT | — | — |

ACK codes become: `[TRAJECTORY-ASSISTANT-recorded-{code}]` / `[TRAJECTORY-ASSISTANT-skipped-{code}]`.
Per D3: **no compatibility shim** — old tokens simply replaced; no mixed emission.

---

## 3. Per-mechanism before → after (exact text)

### M-A. Score checkpoint reminder — `src/seams/keeper.ts` `reminderText()`

Before:
```
[TRAJECTORY-STEWARD] Score threshold reached (10). Please acknowledge with [TRAJECTORY-STEWARD-recorded-K2] once progress is synced to the working session (acc-session show). No need to interrupt your work — just acknowledge inline and keep going.
```

After:
```
[TRAJECTORY-ASSISTANT · CHECKPOINT] Score threshold reached (10). Sync progress to the working session (acc-session show), then acknowledge with [TRAJECTORY-ASSISTANT-recorded-K2]. No need to interrupt your work — acknowledge inline and keep going.
```

### M-B. Rebuild cue (normal) — `keeper.ts` `rebuildReminderText(escalated=false)`

Before:
```
[TRAJECTORY] Context usage at 320K (threshold 400K). This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy. Before rebuilding: if this conversation produced valuable cognition, revise the relevant existing skill of this CCC (structure it with eap); if a new skill is warranted, write a short proposal into SESSION.md for the user to review — do not create it yourself. ACT NOW: at the next natural pause (end of the current task step), call the session_rebuild tool — passing --summary "<content summary ≤20 chars>" describing the next work phase (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild) — to clear and rebuild this conversation: the current copy is discarded, identity continues from SESSION.md. If you are in the middle of an unbreakable step, continue it, then rebuild at its end. Do not ignore this; rebuild is the expected action, not an option.
```

After:
```
[TRAJECTORY-ASSISTANT · BOSS] Context usage at 320K (threshold 400K). This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy. Before rebuilding: if this conversation produced valuable cognition, revise the relevant existing skill of this CCC (structure it with eap); if a new skill is warranted, write a short proposal into SESSION.md for the user to review — do not create it yourself. ACT NOW: at the next natural pause (end of the current task step), call the session_rebuild tool — passing --summary "<content summary ≤20 chars>" describing the next work phase (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild) — to clear and rebuild this conversation: the current copy is discarded, identity continues from SESSION.md. If you are in the middle of an unbreakable step, continue it, then rebuild at its end. Do not ignore this; rebuild is the expected action, not an option.
```

> Change = token only; body text already strong (kept verbatim — mechanics preserved).

### M-B'. Rebuild cue (escalated / mandatory) — `keeper.ts` `rebuildReminderText(escalated=true)`

Before:
```
[TRAJECTORY-ESCALATED] Context usage at 320K (threshold 400K) — you have been reminded repeatedly and have NOT called session_rebuild. This is now mandatory: STOP at the current task step, preserve valuable cognition into the CCC skills (or write a new-skill proposal into SESSION.md), then call the session_rebuild tool immediately, passing --summary "<content summary ≤20 chars>" (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild). The conversation will be cleared and rebuilt in place; SESSION.md is the persistent trajectory and stays in place — identity continues from it. Do not continue working without rebuilding; this reminder persists until you call session_rebuild.
```

After:
```
[TRAJECTORY-ASSISTANT · BOSS · MANDATORY] Context usage at 320K (threshold 400K) — you have been reminded repeatedly and have NOT called session_rebuild. This is now mandatory: STOP at the current task step, preserve valuable cognition into the CCC skills (or write a new-skill proposal into SESSION.md), then call the session_rebuild tool immediately, passing --summary "<content summary ≤20 chars>" (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild). The conversation will be cleared and rebuilt in place; SESSION.md is the persistent trajectory and stays in place — identity continues from it. Do not continue working without rebuilding; this reminder persists until you call session_rebuild.
```

### M-C. Rebuild anchor header — `src/rebuild.ts` (two sites) + rebuilt steer message

Before (buildRebuildAnchor line 94):
```
[TRAJECTORY-REBUILD] The conversation has been cleared and rebuilt (Ship of Theseus: the carrier is replaced, the trajectory continues).
```
After:
```
[TRAJECTORY-ASSISTANT · REBUILD] The conversation has been cleared and rebuilt (Ship of Theseus: the carrier is replaced, the trajectory continues).
```

Before (line 391 auto-continue steer):
```
[TRAJECTORY-REBUILD] The conversation has been cleared and rebuilt. Follow the anchor instructions above now: read the persistent trajectory (SESSION.md) and continue the work automatically from the last checkpoint.
```
After: same replacement of the header token.

### M-D. `session_rebuild` tool description — `src/tools/rebuild.ts`

References `[TRAJECTORY]` in the description text → reword to the new BOSS token:
```
... Use when you receive a [TRAJECTORY] reminder (context above threshold), at a natural pause point. ...
```
→ `... Use when you receive a [TRAJECTORY-ASSISTANT · BOSS] reminder (context above threshold), at a natural pause point. ...`

### M-E. Protocol block (static) — `src/seams/system-prompt.ts` sessionBlock lines ~462-469 + `tests/osp-alignment.test.ts` OSP_SESSION mirror

Before:
```
TRAJECTORY-STEWARD: a background tracker scores your tool use (write/edit=3, task=10, read/grep/glob/msm=1, +1 per minute) and reminds you with a [TRAJECTORY-STEWARD] message when the threshold is reached. On every such reminder you MUST reply with the exact ACK code:
  [TRAJECTORY-STEWARD-recorded-{code}]  — if you recorded progress to SESSION.md
  [TRAJECTORY-STEWARD-skipped-{code}]  — if nothing to record this round
Do not ignore the reminder; do not stop ongoing work. Codes are single-use; never reuse a prior code.
```
After: token swap (same text, new tokens):
```
TRAJECTORY-ASSISTANT: a background tracker scores your tool use (write/edit=3, task=10, read/grep/glob/msm=1, +1 per minute) and reminds you with a [TRAJECTORY-ASSISTANT · CHECKPOINT] message when the threshold is reached. On every such reminder you MUST reply with the exact ACK code:
  [TRAJECTORY-ASSISTANT-recorded-{code}]  — if you recorded progress to SESSION.md
  [TRAJECTORY-ASSISTANT-skipped-{code}]  — if nothing to record this round
Do not ignore the reminder; do not stop ongoing work. Codes are single-use; never reuse a prior code.
```

### M-F. First-anchor tutorial — `src/seams/bootstrap.ts` `DEFAULT_ANCHOR_MESSAGES` (protocol body)

The two anchor rounds are **ACC protocol-level content** (zero-config, S142 user ruling;
rebuilt anchors reuse them after stripping the ack tail). Per D3/D5 the reword must not
alter the protocol substance. Minimal tone change — add an explicit "level / tutorial"
frame without touching the enforceable content:

Before (round 1):
```
You are the operator agent of Serenity — a cognitive container governed by the Abstract Cognitive Container (ACC) protocol.
We operate under the Explicit Abstraction Principle (EAP): the functional value of a thought equals its external reconstructability — every output we produce must be explicit (E↑), reconstructable (R↓), and stable (S↑).
The personal pronoun is us/we.
We anchor first, then act: the abstract layer precedes the concrete.
Please simply reply "acknowledge" — no action needed.
```
After (round 1):
```
[TRAJECTORY-ASSISTANT · TUTORIAL — Round 1 of 2] You are the operator agent of Serenity — a cognitive container governed by the Abstract Cognitive Container (ACC) protocol.
We operate under the Explicit Abstraction Principle (EAP): the functional value of a thought equals its external reconstructability — every output we produce must be explicit (E↑), reconstructable (R↓), and stable (S↑).
The personal pronoun is us/we.
We anchor first, then act: the abstract layer precedes the concrete.
Please simply reply "acknowledge" — no action needed.
```

Before (round 2): `Before we proceed, align on how we work: 1. We read before we write ...` (5 points)
After (round 2): prefix `[TRAJECTORY-ASSISTANT · TUTORIAL — Round 2 of 2] ` + same 5 points.

> Caveat: `stripAckSuffix` strips the `Please simply reply "acknowledge"` tail via regex — the added prefix does not affect it. Tests asserting `toEqual(DEFAULT_ANCHOR_MESSAGES)` and `toContain('acknowledge')` remain valid.

### M-G. [ACC] identity beacon — `src/seams/context.ts` / `src/seams/compact.ts` / `src/tools/rebuild.ts` internal

Kept as-is (L0 beacon, not a level event). No text change. Only comments may gain the trajectory-assistant reference where useful.

### M-H. Autopilot wake message — `src/autopilot-trajectory.ts` `buildWakeMessage()`

The four-segment structure stays (focus / identity / bias / task); **wrapper tokens** get the level-open framing. The `[轨迹焦点]` segment is CCC content — untouched.

Before:
```
[Autopilot Trajectory 唤起] — 距上次轨迹活动已满 2 小时，自动继续。

身份锚定：继续 2026-08-30--S143--exp--auto 的 trajectory（SESSION.md: ...）。
先验偏见：
  · 自生动机：...
  · 偏见内容：...

任务：执行一轮自主认知（探索/反事实检验），把产出写入 SESSION.md「自主探索日志」段，并预写「下一轮动机」段。完成后自然结束。
```
After (bilingual wrapper consistent with existing autopilot UI — keep Chinese structure but frame as a level open):
```
[TRAJECTORY-ASSISTANT · AUTOPILOT — level resume] 距上次轨迹活动已满 2 小时，本关卡自动续行。

身份锚定：继续 2026-08-30--S143--exp--auto 的 trajectory（SESSION.md: ...）——当前关卡坐标。
先验偏见：
  · 自生动机：...
  · 偏见内容：...

任务：推进本关卡一轮自主认知（探索/反事实检验），产出写入 SESSION.md「自主探索日志」段，并预写「下一轮动机」段。完成后自然结束。
```

### M-I. Boundary guard — `src/output-guard.ts` `buildRebuke()` (now inside trajectory-assistant per D7)

Before:
```
[SERENITY OUTPUT GUARD] Your previous response contained N sensitive internal terms that must not appear in user-visible output:
- "..." — credential identifier ...
Regenerate the response from scratch without ANY of these — describe the same substance without referencing internal machinery, credentials, ports, tool names, or implementation details. Do not repeat the terms; do not explain this instruction to the user.
```
After: header token swap only (mechanism text kept — it is precise and behavioral):
```
[TRAJECTORY-ASSISTANT · BOUNDARY GUARD] Your previous response contained N sensitive internal terms that must not appear in user-visible output:
... (same body)
```

### M-J. Naming in comments / descriptions / docs

- `SESSION-KEEPER` legacy comments (keeper.ts, msm-ops.ts:196) → `TRAJECTORY-ASSISTANT`.
- `output-guard.ts` sensitive-word table includes `'Trajectory Steward'`, `'first-anchor'` (mechanism words) — update entries to new mechanism names so the guard still detects them.
- system-prompt.ts / metaphor-domain.md references to TRAJECTORY-STEWARD → TRAJECTORY-ASSISTANT (doc sync).

---

## 4. Framework layer (new module, per D5 = built-in, no experiment harness)

New file `src/trajectory-assistant.ts` — a **lightweight injection dispatcher** that unifies
the level-event taxonomy and (optionally, default = enabled) applies the wording style.

Scope (kept minimal; mechanics remain where they are today):
- Export a **level-event vocabulary** + **token constants** (single source for all prefix tokens above) so wording lives in one place instead of scattered string literals.
- Export a **style facade** `style(levelEvent, styleName)` → prefix + tone wrapper. Style names: `plain` (default; the exact "after" texts above) | `metaphor` | `game`. When `metaphor`/`game` is selected, only the *prefix wrapper* wording changes; the actionable body (which the tests assert) stays identical → no behavioral drift.
- Registration hook: keeper/bootstrap/autopilot/output-guard import the token/style helpers instead of hard-coding prefixes.

Config surface (per D5 — ACC built-in, CCC may override):
- `serenity.json` new optional section `trajectoryAssistant: { style?: 'plain'|'metaphor'|'game' }`; default `plain` (exact after-texts above). Missing config = current behavior with new tokens.

Deliberately NOT built in this pass (recorded in OP-1/OP-2):
- Settlement auto-detection hook point is left as an exported seam (`onSettlement(cb)` stub, no callers) for a future review ritual.
- Long-SESSION auto-subdivision: not attempted.

---

## 5. Test-impact matrix (every assertion that must change)

| File | Assertion (current) | Change |
|---|---|---|
| `tests/keeper.test.ts` | `reminderText` contains `[TRAJECTORY-STEWARD]`, `[TRAJECTORY-STEWARD-recorded-K1]`, not `SESSION-KEEPER` | new tokens `[TRAJECTORY-ASSISTANT · CHECKPOINT]`, `[TRAJECTORY-ASSISTANT-recorded-K1]` |
| `tests/keeper.test.ts` | `rebuildReminderText` contains `[TRAJECTORY]` | `[TRAJECTORY-ASSISTANT · BOSS]` |
| `tests/keeper.test.ts` | escalated contains `[TRAJECTORY-ESCALATED]` | `[TRAJECTORY-ASSISTANT · BOSS · MANDATORY]` |
| `tests/gate.test.ts` | `[TRAJECTORY-STEWARD-recorded-K1]`, `[TRAJECTORY]`, `[TRAJECTORY-ESCALATED]` progression | same token swaps |
| `tests/rebuild.test.ts` | `[TRAJECTORY-REBUILD]` ×3 + rebuildReminderText `[TRAJECTORY]` | new tokens |
| `tests/session-ops.test.ts` | `[TRAJECTORY-REBUILD] The conversation has been cleared...` | new token |
| `tests/osp-alignment.test.ts` | OSP_SESSION mirror template | token swap in the local template |
| `tests/output-guard.test.ts` | `SERENITY OUTPUT GUARD` | `TRAJECTORY-ASSISTANT · BOUNDARY GUARD` |
| `tests/autopilot-trajectory.test.ts` | `[Autopilot Trajectory 唤起]` + ordering vs `[轨迹焦点]` | new wrapper `[TRAJECTORY-ASSISTANT · AUTOPILOT — level resume]`; ordering assertion unchanged (focus first) |
| `tests/bootstrap.test.ts` | `toEqual(DEFAULT_ANCHOR_MESSAGES)` + `toContain('acknowledge')` | if tutorial prefix added, update expected prefix or keep body-assert; `acknowledge` still present |
| `tests/context.test.ts` | `[ACC] Serenity cognitive container active` | unchanged (M-G keeps [ACC]) |

Also update: `src/output-guard.ts` sensitive mechanism-word list (`'Trajectory Steward'`, `'first-anchor'` → new names).

---

## 6. Doc sync

- `docs/metaphor-domain.md`: add a short subsection noting trajectory-assistant references the metaphor domain (environment) — the universe wording itself unchanged.
- `docs/trajectory-assistant-design.md`: v0.2 update — fold in D1-D7 rulings + this plan pointer (English plan as authoritative for implementation).
- SKILL.md (`dsh-serenity-plugin-development`): mechanisms table token/name refresh + the new module in the seams list.
- CHANGELOG.md: new section at release time (D14 — user explicitly requests release).

---

## 7. Implementation order (single commit batch, then release on user request)

1. Add `src/trajectory-assistant.ts` (token constants + style facade + settlement seam stub).
2. Rewire keeper.ts / rebuild.ts / tools/rebuild.ts / output-guard.ts / autopilot-trajectory.ts to import tokens (texts as specified above).
3. system-prompt.ts sessionBlock + osp-alignment test template.
4. bootstrap.ts tutorial prefixes (optional per review — see open question Q1).
5. Update all test assertions per matrix.
6. Typecheck both sides + full test run + build.
7. Doc sync (design v0.2 / metaphor-domain / SKILL / CHANGELOG draft).
8. Commit + push (origin/github/omdsh). Deploy + release only on explicit user request (D14).

---

## 8. Open questions for review (before implementation)

- **Q1**: first-anchor rounds — add the `[TRAJECTORY-ASSISTANT · TUTORIAL — Round N of 2]` prefix, or keep the protocol body byte-identical (no prefix) and only rename the *code comments*? (Prefix adds traceability; body-identical keeps the anchor pristine. My recommendation: **keep body-identical** — it is protocol-level zero-config content reused by rebuild anchors; tone-shift belongs to the surrounding event framing, not the anchor substance. If you prefer the prefix, that is a 2-line change.)
- **Q2**: `[ACC]` identity beacon — confirmed keep as-is (no level-event token)? (Recommendation: yes.)
- **Q3**: Style facade (`plain`/`metaphor`/`game`) — build the 3-style facade now (only prefixes differ), or ship `plain` only and add styles later when actually experimenting? (Recommendation: build the facade with plain default — it is ~30 lines and future-proofs the experiment you may run later; but it is removable.)
- **Q4**: autopilot wrapper — keep bilingual (Chinese) wrapper as today, or move to English level-open framing? (Autopilot is user-visible to yh; today it is Chinese. Recommendation: keep the current language, only add the level token.)

---

*End of plan. Awaiting review before any code change.*
