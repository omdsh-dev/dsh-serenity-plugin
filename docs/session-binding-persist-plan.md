# SESSION Binding Persistence & Switch Guard — Final Implementation Plan (v1.0)

> SESSION: S142 (2026-09-05)
> Status: **APPROVED 2026-09-05 — implemented (commit `feat(session-bound)`), release pending D14**
> Companion research: `docs/session-binding-hardening-research.md` (mechanism evidence)

---

## 0. User rulings (locked)

| # | Ruling |
|---|--------|
| U1 | Persist the SESSION binding **inside the dsh session log** (custom session event — DSH-native, zero harness change) |
| U2 | **Guard every switching path** (use / create / rebuild) — no unguarded way to change binding |
| U3 | **Legacy compatibility via the title only**: a dsh title carrying a SESSION code is auto-persisted as a binding on startup reconcile |
| U4 | **Codes are NOT necessarily `S`-prefixed** — binding anchors on the full SESSION **directory name**, never on a parsed code prefix |
| U5 | **use switch guard = hard**: `session use <different>` is refused; an explicit `--force` (or first releasing via close) is required to switch |
| U6 | **create preserves the current binding**: creating a new SESSION does NOT rename/switch the dsh session; the new session binds only when explicitly `use`d |
| U7 | **close closes the currently-bound SESSION**: `session close` targets the bound session (name optional/validated against bound); lifecycle tracking stays in SESSION.md; a `release` bound event records the close |
| U8 | **All guard/bound messaging in English** (mechanical tokens, LLM-facing) |

---

## 1. Identity model (code-agnostic)

- A SESSION's durable identity = its **AGENT_SESSIONS directory name** — the only disk-unique anchor:
  - `2026-09-05--S155--token订阅套餐管理研究` (S-code, home default)
  - `2026-09-01--S151--autopilot-daily-housekeeping--auto` (autopilot variant)
  - `2026-09-04--apaas-26116` (issue — no S prefix)
- `sessionId` / code = derived display field only (`''` when unparseable → callers use dirName).
- `dirName` + `mdPath` are authoritative in every record.

## 2. Persisted binding event

New module `src/session-bound.ts`:

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Serenity SESSION binding — authoritative; appended on every binding change. Code-agnostic, log-only. */
    'serenity/bound': {
      dirName: string      // full AGENT_SESSIONS dir name — hard identity
      mdPath: string       // SESSION.md absolute path
      sessionId?: string   // display code when parseable; informational
      action: 'activate' | 'switch' | 'create' | 'rebuild' | 'reconcile' | 'release'
      at: number           // epoch ms
      note?: string
    }
  }
}
```

Exports (pure, testable):
- `appendBound(session, action, { dirName, mdPath, sessionId?, note? })` — calls `session.append('serenity/bound', {...})` (log-only, no surfaceOp).
- `readLastBound(session): BoundRecord | null` — tail-scan `snapshotEvents()` for the last `serenity/bound` (latest-wins).
- `boundDir(bound)` / type helpers.

**Authoritative source = last `serenity/bound`** in the dsh session log.

## 3. Write points

| Point | action | Location |
|-------|--------|----------|
| `session use <target>` succeeds (no prior binding) | `activate` | tools/session.ts use branch |
| `session use --force <different>` succeeds | `switch` | tools/session.ts use branch (after guard) |
| `session create` succeeds | `create` — **records the new dir but does NOT switch binding** (U6) | tools/session.ts create branch |
| `session_rebuild` queued | `rebuild` | rebuild.ts queueRebuild |
| Startup reconcile (U3/U4) | `reconcile` (note: auto from title) | context.ts seed |
| `session close` (bound session) | `release` (U7) | tools/session.ts close branch |

All appends go through `appendBound` → the dsh session log persists them with the conversation (survives restart & rebuild — same session id keeps its log).

## 4. Recovery (context.ts seed — replaces fragile text scan as primary)

Priority order:
1. **Bound event**: `readLastBound(session)` → resolve mdPath absolute + `existsSync` → restore active.
2. **Legacy fallback**: existing `parseSessionContextFromEvents` text-scan of `SESSION.md path:` markers (sessions with no bound event yet).
3. **Title reconcile (U3/U4)**: no binding from 1–2 AND the dsh title carries a SESSION reference → `resolveSessionByTitle(title, sessionsDir)` best-matches an existing dir by code segment (any prefix) → append `reconcile` bound → restore.

`resolveSessionByTitle` (new, in session-ops.ts): given a title (e.g. `S142-2026-08-24-概括`, `apaas-26116-…`, full dir name), match AGENT_SESSIONS dirs **without assuming `S`**:
- exact dir-name match → exact code-token match on the `--<code>--` segment (or `--<code>` tail for issue dirs) → unique fuzzy basename match; ambiguous → no match (fail safe, no guess).

## 5. Guards (U2/U5–U7)

### G1 — `session use` hard switch guard (U5)
In the use branch, after resolving target session:
- `current = getActiveSessionInfo(scope)` (memory) **or** `readLastBound(dshSession)` (durable, authoritative).
- If `current` exists **and** `current.dirName !== target.dirName`:
  - Without `--force`: **refuse** → English message:
    `Session is bound to <currentDirName>. Switching to <targetDirName> would orphan the current trajectory. Re-run with --force to switch (or close the current session first).`
  - With `--force`: proceed → rename title → append `{action:'switch'}`.
- Same session use (re-activate) → allowed silently, no new bound needed (or idempotent activate).

### G2 — `session create` preserves binding (U6)
- create still writes the new SESSION dir + template + renames the **new session's own title only when it becomes bound later**.
- It does **NOT** clear/set the current dsh-session binding and does **NOT** rename the current dsh session to the new dir.
- It appends `{action:'create', dirName: <new dir>}` to the log as a record only if a binding context exists — otherwise the create is unbound bookkeeping. (Decision: keep it minimal — record create only when the tool is invoked inside a bound dsh session, so the audit trail shows what was created; binding itself unchanged.)

### G3 — rebuild anchor priority (U2)
- `queueRebuild`: after resolving mdPath, `appendBound(..., 'rebuild')` so the anchor + post-rebuild recovery read the same durable record.
- `buildRebuildAnchor` keeps taking the resolved sessionName/mdPath (now from the durable bound when present — the resolve path already prefers the bound record).

### G4 — close targets the bound session (U7)
- `session close` with no `name`: closes the **currently bound** session (from memory/readLastBound).
- With `name`: validated — must equal the bound session, else refused (`close <other> while bound to <current> — release current first or use --force`? → per U7: close is for the bound one; closing an unbound/other session requires the session to be the active one; simplify: close without name = bound; close with name ≠ bound = refused unless no binding exists).
- On success: append `{action:'release'}` + clear memory (SESSION.md gets the close marks as today — lifecycle lives in SESSION.md, U7).

## 6. Consistency & precedence
- Bound event exists → it wins (title follows binding; rename on switch/rebuild).
- No bound → title reconcile wins (U3).
- No bound + no title → existing fallback / no restore.

## 7. Files touched

| File | Change |
|------|--------|
| `src/session-bound.ts` (new) | event decl + `appendBound` + `readLastBound` |
| `src/session-ops.ts` | + `resolveSessionByTitle(title, sessionsDir)` (code-agnostic) |
| `src/tools/session.ts` | use: hard guard + append activate/switch; create: no takeover + append create; close: bound-target + append release |
| `src/rebuild.ts` | queueRebuild: append `rebuild` bound |
| `src/seams/context.ts` | seed recovery: bound → text-scan → title reconcile |
| `src/autopilot-trajectory.ts` | (read-only consumers) may read bound via readLastBound for target resolution — optional alignment |
| tests | new + updated (below) |

## 8. Tests (pure logic; zero DSH change)

- `session-bound.test.ts`:
  - appendBound writes a `serenity/bound` event readable via snapshotEvents
  - readLastBound latest-wins over multiple bounds
  - bound is log-only (no surfaceOp)
- `resolveSessionByTitle`: matches S-code dir, issue dir (`apaas-26116`), custom-prefix dir, autopilot `--auto` dir; ambiguous → null; unknown → null
- reconcile: no bound + titled session → resolves (any code) → append `reconcile` + restore
- recovery precedence: bound > text-scan > title reconcile
- guard G1: use different dir without force → refused (English msg); with force → switch + bound appended; same-session re-use → allowed
- create G2: current binding preserved (active unchanged, title unchanged), `create` bound recorded
- close G4: no-name closes bound; mismatched name refused; release appended
- rebuild G3: queue appends `rebuild` bound

## 9. Risks / invariants
- **Zero DSH change** — declare module + append + read, all plugin-side.
- Rebuild semantics unchanged — same dsh session id persists; its log (bound events) survives rebuild → authoritative binding survives (Ship of Theseus intact).
- Legacy sessions: keep working via fallback; title reconcile auto-upgrades under any coding.
- Bound event is log-only metadata — never on the model-visible surface, never in the system prompt.
- LLM cannot silently switch: every switch needs `--force` (a deliberate model action with a clear semantic), every change is audited in the log.

## 10. Version / release
- New patch-level version after approval (D14: user requests release explicitly). CHANGELOG + SKILL.md sync at that point.

---

*End of FINAL plan v1.0 — awaiting approval.*
