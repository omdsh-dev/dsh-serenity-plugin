# Slice F — Architecture Gaps (dsp vs ACC spec v1.5.0 + DSH 0.1.2-rc.1)

> Reviewer: slice-F subagent (S142 review round). Scope: **dsp as a system** — structural gaps, not
> line-level bugs. Evidence read-only: `AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/` (dsp
> v1.30.5), `AI_LAB/serenity-acc-specs/README.md` (normative spec v1.5.0),
> `.opencode/skills/dsh-serenity-plugin-development/SKILL.md`, and the production host reference
> `AI_LAB/dsh-harness-public` @ **0.1.2-rc.1**.
> Overlap note: declaration-layer drift (`engines.dsh`, npm descriptions, README version lines) is
> owned by **slice G** (`docs/review/slice-G-declaration-surface.md`); this slice treats those only as
> inputs to the *runtime* compatibility gap (§6).

---

## 1. Executive verdict (the 5 structural gaps that matter most)

**Gap A — There is no host-adapter boundary, so host-contract drift cannot be detected, only suffered.**
Host access is not owned by any module. **37 of the 68 `src/**.ts` files import host packages** (`cordis` /
`@deepseek-ai/dsh-*`), and there are **35 `as unknown as` casts**, of which **≈23 are optional-host-service
probes** (`(ctx as unknown as {get?: …}).get?.('sessionProjections' | 'sessionTitle' | 'workspaceRegistry' |
'tokenMeter' | 'sessionPersistence' | 'connection' | 'webServer' | 'agents' | 'sessions' | …)`). Because the
contract is expressed as an inline structural assertion at each call site, a host rename is a *type-level
fiction* that typecheck cannot catch and runtime cannot report. Both motivating bugs are direct instances:
`Session.events → snapshotEvents()` was patched by a fallback helper (`src/session-ops.ts:42-64`) instead of
being centralized, and `attachment-error → session/attachment-invalid` was patched by accepting three codes
(`src/client/image-fallback-api.ts:23-32`) instead of being derived from a declared contract. The fix belongs
in the *shape* of the code, not in a third fallback.

**Gap B — There is no runtime host-contract verification and no compatibility policy, so a host upgrade is a
silent, all-or-nothing event.** `dsh.plugin.json:6-8` declares `engines.dsh >=0.1.0-rc.5`, but the host does
not read it (verified: no plugin-manifest engines check anywhere under `AI_LAB/dsh-harness-public/packages`),
and `src/invariant.ts` reads `PluginManifest.engines` yet only ever checks tool-list consistency
(`src/invariant.ts:35-45`). The only version probe, `readDshVersion()` (`src/status.ts:28-46`), reads the
**npm-global package.json on disk** — not the running process — and returns `null` on any failure. Nothing
asserts that the live host still exposes `ctx.settings`, `Session.snapshotEvents`, the `tools/pre-execute`
seam shape, or the error-code vocabulary dsp encodes. Consequence: rc.1 shipped **two** contract breaks that
surfaced only as user-visible malfunction (first-anchor re-injection per turn, session-restore loss, image
fallback never firing) — `src/session-ops.ts:43-49` documents exactly this.

**Gap C — Failure policy is absent: contract violations and benign degradation are handled by the same
silent `catch {}`.** There are **121 `catch {` sites** and **150 `throw new Error(` sites** with no error
taxonomy. The dangerous pattern is not catching — it is *failing open into a plausible-looking state*: a
corrupt `serenity.json` becomes `{}` (`src/ccc.ts:292-296`), which silently drops the safe-mode blacklist and
the handyman whitelist; a missing `ctx.settings` becomes process defaults (`src/settings-section.ts:181-183`),
which silently ignores every user toggle; a throwing `snapshotEvents()` becomes `[]` (`src/session-ops.ts:59-61`),
which is indistinguishable from "new session". A host-contract violation must be **loud and recorded**; only
user-data failure may degrade. Today both look the same on the wire.

**Gap D — Spec conformance is partial and unverified where it matters most.** The spec's **§10 error
contract is entirely unimplemented**: 13 error classes with `serenityCode` (`E-GIT-001` … `E-CCC-003`) have
**zero occurrences** in dsp (`grep serenityCode|E-*-NNN` → 0 matches); every failure is a bare `Error`. §3.1
"配置单真源" is violated by **four** configuration stores (§7.1). §3.1's default threshold is **100**, dsp
defaults to **150** (`src/seams/keeper.ts:150`, `src/index.ts:93`). §5.11 specifies a 3-character random ACK
code; dsp emits a sequential `K1, K2, …` (`src/seams/keeper.ts:62-67`). I5 ("Induction content consistent")
is broken by the persona feature, which replaces the EAP block and strips the MSM-principles segment
(`src/seams/system-prompt.ts:487-496`). None of these has a verification path — the only conformance gate is
`tests/osp-alignment.test.ts`, which asserts dsp's own text against itself.

**Gap E — Observability is per-mechanism and reactive, so dsp cannot answer "am I healthy?" about itself.**
`dashboard health` checks **CCC** properties (`.serenity`, git, config-file existence, MSM registry integrity —
`src/kit-ops.ts:139-190`), not dsp. Diagnostics exist only where a past bug forced them into existence:
`AGENT_SESSIONS/.restrict-diag.json` (`src/seams/guards.ts:247-260`) and `AGENT_SESSIONS/.rebuild-diag.json`
(`src/rebuild.ts:216-240`), each added after "调用成功但没重建——错误被 console.warn 吞掉不可见". The 9 seams,
the gateway, the WeChat bridge, Skiff and ACP have no health surface; their failure modes are discoverable
only by reading stdout logs or by user report. There is no seam that would have reported the rc.1 drift.

---

## 2. Spec conformance gap table

Spec = `AI_LAB/serenity-acc-specs/README.md` v1.5.0. "Verification path" = what would catch a future
deviation. Severity: **P0** correctness/security/continuity now · **P1** real gap, plan next · **P2** hygiene.

| ID | Spec ref | Requirement | dsp reality (file:line) | Severity | Fix |
|----|----------|-------------|-------------------------|----------|-----|
| F-01 | §10 | 13 error classes + `serenityCode` (`E-GIT-001`…`E-CCC-003`), errors preserve stdout/stderr (C3) | **Not implemented.** 0 matches for `serenityCode` / `E-*-NNN`; 150 bare `throw new Error(...)` (`src/fs-ops.ts:168-517`, `src/msm-ops.ts:63-636`, `src/session-ops.ts:169-717`, …). Tools surface free-text strings only | **P1** | Introduce `SerenityError` with `code`/`serenityCode`; map the 13 spec classes onto existing throw sites; assert codes in tests. No caller needs to change behaviour to gain machine-readable failures |
| F-02 | §3.1 | `serenity.json` is the **single config source**; read `.<host>/serenity.json` → fallback `.opencode/serenity.json` | **Four stores**: CCC `serenity.json` (`src/ccc.ts:288-299`), DSH `settings.yaml` via `SettingsProvider` (`src/settings-section.ts:138-184`), plugin-global `~/.dsh/serenity-hooks.json` (`src/config-ops.ts:1-16`), CCC `localstore.json` (`src/localstore-ops.ts`). Prior duplication was already found and called a "死双胞胎" (`src/config-ops.ts:78-81`) — the pattern recurs | **P1** | Publish one resolution table (key → owner store) in the skill; add a test asserting each runtime-read key resolves from exactly one store; forbid new keys outside CCC `serenity.json` unless host-scoped |
| F-03 | §3.1 | `sessionKeeper.threshold` **default 100** | **150**: `src/seams/keeper.ts:150` (`opts.defaultThreshold ?? 150`), `src/index.ts:93`, documented as 150 at `src/msm-ops.ts:203` | P2 | Set 100 or amend the spec (dsp is the leading implementation — pick one, record the decision) |
| F-04 | §5.11 | ACK code = **3-character random (letters+digits)**, single-use, reset score | **Sequential `K<n>`**: `src/seams/keeper.ts:62-67` (`return \`K${this.counter}\``). Predictable and not 3-char; reset semantics do hold | P2 | Generate `randomBytes`-derived 3-char code; keep single-use semantics; update the Session-block predeclaration text if wording changes |
| F-05 | §1 I5, §5.5 | Induction content must match the standard (dynamic fields only); EAP block is part of layer B | **Persona replaces the EAP block** and strips MSM-principles from Principles when `persona.mode` is set (`src/seams/system-prompt.ts:487-496`, `principlesBlock(root, personaOn)` at `:179`, `personaBlock` branch at `:495`) | P2 | Either exempt persona explicitly in the spec (it is a deliberate user-facing feature) or move persona to an appended block that does not displace layer B |
| F-06 | §4.1 / §5.8 | `container_git` = status/commit/push/log/**pull/diff**; toolsBlock lists the minimum set | Implementation has 6 actions (`src/git-ops.ts:147` pull, `:175` log, diff path), but the injected Tools block advertises **4** — "git operations (status/commit/push/log)" (`src/seams/system-prompt.ts:104`) | P2 | Add pull/diff to the toolsBlock line (the model cannot use what the capability index does not mention) |
| F-07 | §4.3 | Registry write-deny / read-allow, `references/` node protected, single legal write channel | **Implemented and verified**: `container_fs` all write ops route through `validateWritePath` → `assertNotProtectedRegistry` (`src/fs-ops.ts:146-206`, called at `:290,:311,:362-363,:375-376,:390,:403`); guard seam denies write tools on the aggregate file and the `references/` node (`src/seams/guards.ts:74-104,192-197`) | ✅ | — |
| F-08 | §4.3 | `dashboard health` must include registry integrity (parse/BOM/wrapper/field types/unique name/path-inside/script-exists); broken table must not throw | **Implemented** (`src/kit-ops.ts:63-135`, wired at `:180-183`) | ✅ | — |
| F-09 | §3.2 | Entry-skill discovery order `.serenity` → `.dsh/entry-skill` → `.opencode/skills/*-serenity` → `.dsh/skills/*-serenity` | Implemented (`src/skills-discovery.ts`; four-source superset per appendix A) | ✅ | — |
| F-10 | §6 S1 | pre-tool gate allow/deny/ask; path escape + blacklist + safe-mode | Implemented as `tools/pre-execute` waterfall **plus** terminal `ctx.tools.guard` (`src/seams/guards.ts:332-359`) | ✅ | — |
| F-11 | §6 S4 | DCP reminder, observe-and-enrich, never veto | Implemented (`src/seams/keeper.ts:170` post-execute → additionalContexts) | ✅ | — |
| F-12 | §6 S5 | Turn-boundary persistence | Implemented via `agent/turn-stopping` (`src/rebuild.ts:395`, `src/output-guard-seam.ts:56`) | ✅ | — |
| F-13 | §6 S7 | Sub-agent inherits all constraints | Relies on the host's native inheritance; **no dsp-side verification** — a Skiff/handyman child is bypassed deliberately (`src/seams/context.ts:119-120,155,237`), so the "no bypass" claim rests on the guard seam alone | P2 | Add an assertion-style test that a handyman child's tool call still hits `decideGuard` |
| F-14 | §5.10 | Re-inject ACC identity after successful compact | Implemented (`src/seams/compact.ts`), but the idempotence key is an **in-process `Set`** (`src/seams/context.ts:95`) — lost on restart, so re-seeding after restart is inferred from event history (`shouldRestoreActive`, `:129-133`) rather than asserted | P2 | Derive "already seeded" from a persisted session event instead of process memory; makes idempotence restart-stable and observable |
| F-15 | §9 checklist | "不重复实现平台原生能力" | Mostly respected, but dsp re-implements config layering, prompt assembly ordering and a second HTTP server (gateway) around host facilities; see §7 | P2 | Document each deliberate divergence in the skill's decision table |

**Conformance coverage verdict.** Of 15 checked clauses, **7 fully conform, 8 do not** (2 of those P1).
The spec has **no machine-readable conformance suite**; `tests/osp-alignment.test.ts` compares dsp text to
dsp text, so it cannot detect drift from the standard.

---

## 3. Host-adapter boundary

### 3.1 Current state (evidence)

There is no module that owns host access. The surface is:

| Evidence | Count | Sites (sample) |
|---|---|---|
| `src/**.ts` files importing host packages (`cordis`, `@deepseek-ai/dsh-*`) | **37** | `seams/*` (8), `tools/*` (13), root modules (14), `client/*` (2) |
| `as unknown as` assertions | **35** | full list via `grep "as unknown as"` |
| Of those, optional-host-service probes (`ctx.get?.(…)` / `ctx.<svc>?`) | **≈23** | `keeper.ts:110` sessionProjections · `session.ts:184` sessionTitle · `rebuild.ts:372,414` sessionTitle/tokenMeter · `skiff-debug.ts:89,99` workspaceRegistry/sessionPersistence · `api.ts:335` workspaceRegistry · `gateway.ts:566,607` connection/webServer · `index.ts:223,248` sessions/webServer · `skiff-core.ts:248`, `autopilot-trajectory.ts:417-418,491,506,525,626`, `weixin-bridge.ts:398` sessions/agents · `settings-section.ts:158,164` emit/settings |
| Direct `ctx.<service>` uses without any probe | dozens | `ctx.tools.register` (`index.ts:109-120`), `ctx.on(...)` (12 seams), `ctx.skills.registerProvider` (`opencode-skills.ts:64`), `ctx.shellEnv.register` (`env.ts:46`), `ctx.systemPrompt.section` (`system-prompt.ts:561,604`), `ctx.agents.create/resume/get` (`skiff-core.ts:282,301,248`) |
| Host event names hard-coded as string literals | **≥14 distinct** | `agent/session-start`, `agent/pre-step`, `agent/turn-stopping`, `agent/status`, `agent/inbox/inserted`, `tools/pre-execute`, `tools/post-execute`, `session/event`, `session/created`, `system-prompt/assemble`, `compaction/*`, plus dsp-private `serenity/*` |

Two structural properties follow, both bad:

1. **No single place to verify or upgrade.** An rc.2 rename of `ctx.settings`, `Session.snapshotEvents`, or
   an event name requires an exhaustive repo-wide hunt. The rc.1 adaptation touched ~37 files for exactly
   this reason (see `docs/dsh-0.1.2-rc1-adapt-plan.md`, `…-adapt-report.md`).
2. **No way to fail loudly.** Because each site asserts its own shape, absence is indistinguishable from
   "not applicable". The host *does* have a precise contract — `packages/extensions/tool-cordis/src/api-catalog.ts:4799`
   publishes the full `Session` declaration, whose only event accessor is
   `snapshotEvents(fromSeq, toSeqExclusive)` — but dsp encodes that fact in three independent places
   (`src/session-ops.ts:52-64`, `src/tools/handyman.ts:75-78`, `src/skiff-core.ts:379-389`) and two of them
   contradict the first file's own instruction "所有消费方一律经此读取，禁止再裸读 `.events`"
   (`src/session-ops.ts:49` vs `handyman.ts:78`, `skiff-core.ts:387-388`).

**Test-side evidence that this is the root cause.** All 53 test files build hand-written doubles; **zero**
tests import a real host package (`grep "from '@deepseek-ai/dsh-" tests/` → 0 matches). The doubles encode
dsp's beliefs (`tests/session-bound.test.ts:15` `snapshotEvents: () => events`, `:75` "无 snapshotEvents →
走 .events 兜底"), so the test suite was green while the production contract was broken. The `.events`
fallback is *dead code in production* and exists only to keep those doubles alive.

### 3.2 Proposed boundary

Introduce **`src/host/`** as the single module allowed to touch `Context`, host events, host classes and
host error shapes. Three layers, strict dependency direction (`host ← ops ← tools/seams`):

**Belongs inside `src/host/`**
- **Service accessors** — one typed getter per host service, each returning a discriminated result
  (`{ ok: true, value } | { ok: false, missing: 'settings', contract: 'ctx.settings' }`) instead of `undefined`:
  `settings()`, `sessions()`, `agents()`, `sessionTitle()`, `tokenMeter()`, `workspaceRegistry()`,
  `sessionPersistence()`, `connection()`, `webServer()`, `sessionProjections()`, `shellEnv()`, `skills()`, `tools()`.
- **Contract declarations + capability probe** — `hostContract.ts`: the exact shape dsp requires of each
  service, the exact event names it subscribes to, the exact error codes it matches, and a
  `probeHost(ctx): HostReport` that checks each one at mount and returns per-capability pass/fail with the
  observed-vs-expected shape. This is the runtime guard that Gap B needs.
- **Event subscriptions** — `onHostEvent(ctx, name, handler)` with the name from a single enum, so the
  subscribe set is enumerable and testable.
- **Session event access** — one `sessionEvents(session)` (already written at `session-ops.ts:52`); delete
  the two local copies. When `snapshotEvents` is absent, **report** the missing contract instead of
  falling back to `.events`.
- **Error-code matching** — `isImageFallbackTrigger` (`client/image-fallback-api.ts:32`) becomes a
  table-driven check over a declared code set, so a new code is a one-line table edit, and an *unknown*
  code is surfaced as "unrecognised host error code" rather than silently `false`.

**Stays outside**
- All CCC-domain logic (fs/git/msm/session/logbook/registry/localstore) — already host-free and unit-testable
  by design; keep it that way.
- Prompt **text** (the Induction blocks) — content, not host binding. `seams/system-prompt.ts` should receive
  already-resolved facts (root, cccName, active session) rather than reaching into `ctx`.
- Client half (`src/client/`) — needs its own parallel boundary later (it consumes host client packages);
  out of scope for the first migration.

### 3.3 Migration shape

1. **Extract, don't rewrite** (no behaviour change): move the ~23 probe sites into `src/host/*` behind
   accessors that currently return the same values; keep every existing call site's semantics.
2. **Make absence loud** in one place: accessors record to the diagnostics surface (§5) instead of
   returning `undefined`; add `dashboard health` → `host` section from `probeHost`.
3. **Add a real-host contract test** (new, separate vitest project) that boots a minimal host context and
   asserts: the 10 tools register; the subscribed events exist; `Session.snapshotEvents` is a function;
   `ctx.settings` installs a section. This is the only test class that would have caught both motivating
   bugs; it needs the host as a dev dependency and must not replace the existing fast doubles.
4. **Delete the drift-hiding fallbacks** once (3) is green: `.events` fallback, triple error-code match,
   silent `{}` config. Each removal converts a silent path into an asserted one.
5. **Guard the boundary mechanically**: a test that greps `src/` (excluding `src/host/` and `src/client/`)
   for `as unknown as` / `from 'cordis'` / `@deepseek-ai/dsh-` and fails on new occurrences. This is cheap
   and is the enforcement that keeps the boundary from eroding — the same shape as the existing
   `coverage-gate.test.ts` mirror gate.

Estimated effort: extraction P1 ≈ 1–1.5 days; probe + health wiring ≈ 0.5 day; real-host contract test
≈ 1–2 days (host boot scaffolding is the unknown); mechanical boundary guard ≈ 2 hours.

---

## 4. Failure-mode / degradation audit

### 4.1 Counts

| Pattern | Count | Notes |
|---|---|---|
| `catch {` (all forms, incl. commented) | **121** | `grep -c` per file: `autopilot-trajectory.ts` 14, `gateway.ts` 14, `fs-ops.ts` 6, `seams/context.ts` 5, `skiff-debug.ts` 5, `weixin-api.ts` 4, `seams/system-prompt.ts` 4, `index.ts` 4, … |
| `throw new Error(` | **150** | no error subclass, no code, no `serenityCode` |
| Optional-service access without a guard that reports | ≈23 | §3.1 table |
| Error taxonomy classes | **0** | spec §10 requires 13 |
| Diagnostics surfaces | **2 ad hoc files** | `.restrict-diag.json`, `.rebuild-diag.json` |
| `console.warn` / `console.error` / `console.log` sites | 97 matches | the *de facto* error channel; not queryable, lost on restart |

Not all 121 catches are defects — many are correct best-effort paths (`gateway.ts:227-249` socket teardown,
`config-ops.ts:160` chmod on read-only mount, `msm-ops.ts:45` continue-on-candidate-failure). The defect
class is narrower and specific: **a catch that converts a *contract or data-integrity* failure into a
plausible normal state**.

### 4.2 Worst examples (contract-violation masking)

| # | Site | Masks | Observable consequence |
|---|---|---|---|
| 1 | `src/ccc.ts:292-296` `loadSerenityConfig` — parse failure → `return {}` | A corrupt/unreadable `serenity.json` | **Security-relevant**: `safeMode.blacklist` becomes empty (`readBlacklist` → `[]`, `:321-324`), handyman model whitelist disappears (`readHandymanConfig` → `null`), keeper threshold reverts. The guard silently stops guarding |
| 2 | `src/session-ops.ts:52-64` `sessionEvents` — `snapshotEvents()` throws → fall back to `.events` (absent in rc.1) → `[]`; `null` session → `[]` | Host contract break **and** genuinely-empty session, indistinguishably | The exact rc.1 failure: first-anchor re-injected every turn, session restore lost, rebuild mis-located (`:43-49` documents the user-visible symptoms) |
| 3 | `src/tools/handyman.ts:75-78` and `src/skiff-core.ts:379-389` — two more copies of the same fallback | Same, plus divergence risk | A future host change must be fixed in three places; the file that declares the single-source rule is not the file that is obeyed |
| 4 | `src/settings-section.ts:181-183` — no settings provider → `hooks.setSource(() => ({}))` → `readSimpleSettings()` returns `defaultSimpleSettings()` (`:118-120`), **no warning** | Absence of the host settings service | Every user toggle silently ignored: gateway off, autopilot off, rebuild thresholds reset. Looks like "the feature just doesn't work" |
| 5 | `src/client/image-fallback-api.ts:23-32` — matches 3 codes; unknown code → `false` | Any *future* host error-code rename | Fallback silently stops firing again, with no negative signal (this is the second motivating bug, patched but not structurally closed) |
| 6 | `src/output-guard.ts:118-120, 134-136` — credential table and MSM-word table built inside `try{}catch{}` | Unreadable `localstore.json` / broken registry | Output guard silently weaker; the compensating control for credential leakage degrades without a trace |
| 7 | `src/seams/guards.ts:257-259` — `writeRestrictDiag` catch | Failure to write the diagnostic file | The one channel that would explain a restrict failure is itself silently lost |
| 8 | `src/index.ts:205-209, 280-284` — `ctx.on('serenity/settings-changed', sync)` inside try/catch | Missing event channel | Gateway/ACP/Skiff never hot-reload after a settings change; only a restart helps |
| 9 | `src/seams/context.ts:207-209` — restore chain catch | Failure of the whole three-path restore | Session block silently empty; user sees "no active session" with no reason |
| 10 | `src/seams/guards.ts:99-101` — `isProtectedRegistryRel` catch → **fail open** (no protection) | Unreadable `.serenity` marker | Registry write protection silently off (documented as deliberate anti-deadlock, but it is still a fail-open security path) |

### 4.3 Missing policy (proposed)

State it once, in the skill and in `src/host/`, and enforce it at the boundary:

1. **Host-contract violation → loud + recorded, never masked.** Missing/renamed host service, event, class
   member or error code is *not* a degradation: record it to the diagnostics surface, emit one
   `console.error` with the expected-vs-observed shape, and surface it in `dashboard health`. No silent
   fallback to a stale alternative (delete the `.events` fallback and the triple-code match).
2. **User-data / environment failure → degrade, but visibly.** Corrupt `serenity.json`, unreadable
   `localstore.json`, permission-denied writes: degrade to a safe state, but record the reason and mark the
   affected feature degraded in health. Never degrade a *guard* (blacklist, credential block, output guard)
   without reporting it — a guard that silently weakens is worse than one that refuses.
3. **Every catch must name its class.** A mechanical lint/test rule: each `catch` block either (a) rethrows,
   (b) records to diagnostics with a reason string, or (c) carries an explicit `/* best-effort: <why> */`
   marker. The 121 sites are auditable in one pass; the rule prevents regression.
4. **One diagnostics surface, not per-mechanism files.** Replace `.restrict-diag.json` + `.rebuild-diag.json`
   with `AGENT_SESSIONS/.acc-diag.json` (single file, sections per subsystem, ring-buffer of last N events)
   written by a `host/diagnostics.ts` sink; keep the file channel (it exists precisely to avoid HTTP
   self-lock — `guards.ts:247`) and expose it via `dashboard health` and a `container_admin` subcommand.
5. **Enforce where it cannot be bypassed**: the sink belongs to `src/host/`, so a subsystem cannot record
   without going through the boundary; the lint rule is a test, so it runs in CI.

---

## 5. Observability blind spots

Current visibility: `dashboard health` (CCC P1/P2/P3 + registry integrity + `accVersion`/`dshVersion` from
disk — `src/kit-ops.ts:137-190`), `container_admin msm check` (DC-M1~M4 registry quality —
`src/msm-ops.ts:531-561`), `container_admin role validate`, two diag files, `skiff-debug` HTTP page,
`autopilot-trajectory diag`/`diag-live` (`src/autopilot-trajectory.ts:684`), WeChat `weixin-doctor` MSM,
`dsh-crash-investigate` (external dev tool), and 97 console sites.

| Subsystem | Current visibility | Blind spot | Minimal addition |
|---|---|---|---|
| **Host contract** (services/events/classes) | none (`dshVersion` read from disk only) | Any rc.x rename — the exact failure that shipped twice | `host.probe` section in `dashboard health`: per-capability ok/missing + expected-vs-observed |
| **Seams (9)** | individual `console.*` + one `try/catch` at registration (`system-prompt.ts:578-581`) | Whether each seam actually registered and is firing (no counters, no last-fired timestamp) | One counter + last-invoked ts per seam, exposed in `dashboard health` |
| **Guards / safe mode** | `.restrict-diag.json` (last attempt/success/error, active keys) — good, but only for `restrict` | Whether `tools/pre-execute` / `ctx.tools.guard` are attached at all; deny counts | Extend the same diag record with `preExecuteAttached`, `guardAttached`, deny-count |
| **Gateway (3081)** | console logs at start/stop/login; `gateway-diag` MSM (dev) | No runtime health: listening? upstream reachable? cookie exchange working? last error | `gateway` section: listening state, port, upstream ping, dsh-cookie status, last 5 auth failures |
| **WeChat bridge** | console logs; `weixin-doctor` MSM | Per-account poll health, last inbound/outbound, queue depth, auth expiry | Extend `weixin-doctor status` into the unified health report |
| **Skiff / ACP (3099/3100)** | console at start; `skiff-debug` page | Service started? key configured? last request/error? role config valid? | `faces` section: enabled flags, actual listening state, last request ts, last error |
| **Handyman** | progress files `handyman-<label>.md/.json` | Round counts, restart counts, model resolution failures across runs | Aggregate progress files into a `handyman` section |
| **Session/logbook** | `logbook health` (stale/stalled/drift/ghost) — decent | Whether the *active-session binding* is live, and which of the 3 restore paths won | Record the winning restore path (`bound`/`text`/`title`) in diagnostics; show in Session block + health |
| **Rebuild** | `.rebuild-diag.json` (queue/rebuilt/dropped/failed) — good | Token-meter availability (`rebuild.ts:413-419` silently degrades), threshold source | Add `tokenMeterAvailable` + resolved threshold to the same record |
| **Output guard** | console on steer (`output-guard-seam.ts:86-102`) | Whether the sensitive table built successfully (catches at `output-guard.ts:118,134`) | `outputGuard` section: word counts per category, last build ok/err |
| **Config resolution** | `dashboard health` shows config file *existence* + parsed object | Which store won for each key; parse failures (swallowed at `ccc.ts:294`) | `config` section: per-key source + parse status |
| **MSM registry** | `checkRegistryHealth` (strong) + DC-M1~M4 | Nothing significant | Fold into the unified report |

**Minimal observability addition (one change, high leverage):** make `dashboard health` return a `subsystems`
object assembled by the host boundary (§3) and the diagnostics sink (§4.3) — a single call an operator or
agent can make to answer "what part of dsp is not working right now". Everything in the table above reduces
to "one section, fed by the boundary". Effort ≈ 1 day after the boundary exists; without the boundary it is
another 10 scattered diag files.

---

## 6. Version / compatibility strategy

### 6.1 Current state

| Mechanism | Where | What it actually does |
|---|---|---|
| `peerDependencies` — 16 host packages, all `^0.1.2-rc.1` | `package.json:54-71` | npm install-time resolution only; says nothing about the *running* process |
| `engines.dsh: ">=0.1.0-rc.5"` | `dsh.plugin.json:6-8` | **Never enforced.** Host has no plugin-manifest engines check (verified across `AI_LAB/dsh-harness-public/packages`); `src/invariant.ts:17` types the field but `verifyToolConsistency` (`:35-45`) only compares tool lists. Also contradicts the peer range (slice G, finding G-1) |
| `ACC_VERSION` | `src/constants.ts:14-22` | dsp's own version, read from its `package.json` — not the host's |
| `readDshVersion()` | `src/status.ts:28-46` | Reads `@deepseek-ai/dsh/package.json` from three *disk* locations; returns `null` if not found. **Does not identify the running host** (a container/bundled/differently-prefixed host reports `null` or the wrong install) |
| Manifest tool-list invariant | `src/invariant.ts:35-45` | The only structural self-check; tool lists only |
| Ad-hoc compatibility code | `session-ops.ts:52-64`, `image-fallback-api.ts:32`, `handyman.ts:78`, `skiff-core.ts:385`, `settings-section.ts:139-142`, `gateway.ts:556-585` | Each is a *post-hoc* accommodation of a specific break, discovered in production |

**The gap, stated precisely:** dsp has a *declared* compatibility floor, an *install-time* dependency range,
and a *disk* version probe — and **no runtime detection that the live host still satisfies dsp's contract
assumptions**. There is also no compatibility matrix (which dsp version supports which host version, what
breaks across rc.x) and no deprecation path (how dsp tells a user "upgrade the plugin" vs "upgrade the host").
Evidence that this costs real time: `docs/dsh-0.1.2-alpha-impact-assessment.md`,
`docs/dsh-0.1.2-rc1-adapt-plan.md`, `docs/dsh-0.1.2-rc1-adapt-report.md` — a full manual adaptation round
for one rc bump, plus the two drifts that escaped it.

### 6.2 Proposed strategy

**A. Declare the contract (one file).** `src/host/contract.ts` — the machine-readable list dsp depends on:
required services with their required members, required events, required class members, matched error codes,
and a `MIN_HOST` / `MAX_HOST_TESTED` range. Single source for: the runtime probe, the manifest `engines.dsh`,
the peer range, and the compatibility matrix doc. Slice G's G-1 (engines vs peerDeps contradiction) is fixed
by deriving both from this file.

**B. Detect at runtime, at mount, once.** `probeHost(ctx)` in `apply()` (after `ctx.tools.register`), and
again after `compaction/end` (the host may have re-assembled). For each contract item: present / missing /
wrong-shape. Outcomes:
- **all present** → record `host: ok` in diagnostics; expose `hostContract` in `dashboard health`.
- **required item missing** → `console.error` with expected-vs-observed + record; **do not** silently
  substitute a fallback. Behaviour: keep the parts of dsp that can work, disable the parts that cannot, and
  say which is which (e.g. "`ctx.settings` missing → simple settings unavailable; gateway/ACP/rebuild
  switches ignored").
- **optional item missing** → record as `degraded` with the feature name; no error.

**C. Decide what to do on mismatch (the policy the spec lacks).**
- *Unknown/newer host within the same major* → run; log `host newer than tested (X > Y)`, keep going.
- *Contract item missing* → degrade that feature loudly (above), never mask.
- *Contract item present but wrong shape* (e.g. `snapshotEvents` exists but returns a non-array) → treat as a
  hard contract violation: error + disable the dependent mechanism, because a wrong shape means the
  assumption is void, not merely absent.
- *Host below `MIN_HOST`* → refuse to activate ACC mechanisms, print the reason, leave the CCC untouched
  (consistent with I2 "无 `.serenity` 零影响" philosophy: better to do nothing than to do wrong things).

**D. Make it visible and testable.** `dashboard health` → `host` section (host version if obtainable,
per-capability status, `newer-than-tested` flag). A real-host contract test (§3.3 step 3) runs the probe
against the actual host, so an rc bump fails CI instead of production. A one-row compatibility matrix in the
skill: dsp version ↔ host versions tested ↔ known breaks.

**E. Keep a deprecation path.** When dsp must support two host shapes (as now), the shim lives **only** in
`src/host/`, carries a `remove after host >= X` note, and is covered by a test that asserts *both* shapes
are exercised — so the shim cannot outlive its justification unnoticed.

Effort: contract file + probe ≈ 1 day; health/UI wiring ≈ 0.5 day; real-host contract test ≈ 1–2 days;
matrix doc ≈ 1 hour.

---

## 7. Other structural gaps

### 7.1 Duplicated mechanisms

| # | Duplication | Evidence | Consequence |
|---|---|---|---|
| 1 | **Four config stores** | CCC `serenity.json` (`ccc.ts:288`), host `settings.yaml` (`settings-section.ts`), plugin-global `~/.dsh/serenity-hooks.json` (`config-ops.ts:1-16`), CCC `localstore.json` (`localstore-ops.ts`) | A key can be read from one store and written to another; the "死双胞胎" precedent (`config-ops.ts:78-81`, a rebuild toggle that was echoed but never read) already caused a user-visible no-op |
| 2 | **Two prompt-injection paths + two section registrations** | `agent/session-start` seed (`context.ts:219-226`) **and** `agent/pre-step` inject (`:230-251`), both gated by the same in-process `Set` (`:95`); plus a *global* `systemPrompt.section` (`system-prompt.ts:561`) and an *agent-scoped* one (`:604`), same content, "scoped wins, global is fallback" (`:156-157`) | Four ways for identity text to reach the model; idempotence is process-local, so restart re-seeds and post-compact re-injection is inferred rather than asserted (F-14) |
| 3 | **Three session-resolution paths** | `bound` event → text scan → title reconcile (`context.ts:171-197`), each with its own `existsSync` guard; the winner is not recorded | Ambiguous provenance; a stale binding and a fresh reconcile look identical to the agent; debugging requires reading three code paths |
| 4 | **Three `sessionEvents` implementations** | `session-ops.ts:52` (canonical), `handyman.ts:75-78`, `skiff-core.ts:385-389` — the latter two explicitly acknowledge the duplication (`skiff-core.ts:382-383`) | The declared single source is not the enforced one; a host change needs three edits |
| 5 | **Two "last assistant text" extractors** | `handyman.ts:74-91` and `skiff-core.ts:391-397` ("handyman 同款") | Same parsing of `assistant/message` shape in two places, drifting independently |
| 6 | **Two HTTP faces on separate servers** | gateway 3081 (`gateway.ts`, second `node:http`) + ACP/ask 3100 (`acp-http.ts`) + Skiff 3099 (`skiff-debug.ts`) + host webServer routes (`api.ts`) | Four listeners, three auth models (cookie+CSRF+TOTP / key+IP-lockout / none-loopback), no single place to reason about the external attack surface |
| 7 | **Two diagnostics files, two patterns** | `.restrict-diag.json` (`guards.ts:247`), `.rebuild-diag.json` (`rebuild.ts:236`) | Each new mechanism invents its own file; no unified query |
| 8 | **Dead / vestigial code** | `onSettlement` with no caller (`trajectory-assistant.ts:76-83`, self-documented OP-1); `.events` fallback dead in production (`session-ops.ts:63`); `tools/cc-fs.ts`-era naming retained in comments; `WRITE_TOOLS` in `ccc.ts:357` duplicating `isWriteTool` in `guards.ts:114-118` with **different membership** (`ccc.ts` includes `bash`, `guards` adds action-awareness) | Two write-tool predicates with divergent semantics is a guard-bypass risk if the wrong one is used at a new site |

### 7.2 Module-layout entropy

- `src/` mixes four concerns at one level: pure domain ops (`fs-ops`, `git-ops`, `session-ops`, `msm-ops`),
  host-bound seams (`seams/`), tool shells (`tools/`), and host services (`gateway*`, `api`, `acp*`,
  `weixin*`, `skiff*`). The host-free invariant ("零 DSH 依赖，可独立单测") is stated per file
  (`session-ops.ts:2`, `kit-ops.ts:2`, `ccc.ts:2`) but **not enforced** — and is already violated in spirit
  by files that both compute and touch `ctx`.
- The largest modules are the least decomposed: `session-ops.ts` (36 KB), `msm-ops.ts` (36 KB),
  `gateway.ts` (34 KB), `system-prompt.ts` (33 KB), `acp-http.ts` (31 KB). The v1.22.8 gateway split
  (`gateway-auth` / `gateway-proxy`) is the right pattern, applied once.
- `tools/` contains legacy shells that are no longer registered as separate tools (`tools/eap.ts`,
  `tools/neat.ts`, `tools/cce.ts` are content sources for `praxis`; `tools/cc-fs.ts` / `tools/git.ts` /
  `tools/kit.ts` are thin wrappers) — the v1.30 rename left naming that no longer matches the tool surface.

### 7.3 Security-boundary observations (external faces)

| # | Observation | Evidence | Assessment |
|---|---|---|---|
| S-1 | **Credential hard-block is path-name based and bypassable** | `guards.ts:179-181` denies `rel === 'localstore.json'` only; `extractPathArg` (`:302-313`) reads `path/file_path/target/src/dst`. A symlink inside the root pointing at `localstore.json` yields a different `rel` → allowed; `bash cat localstore.json` is only blocked in safe mode (`:162-164`) | **P1** (agent-reachable, non-safe-mode). Fix: `realpath` in the guard, and deny any command containing a credential path for `bash`, or accept "safe mode is mandatory for credential containment" and state it |
| S-2 | **`originAllowed` fails open on a missing/`null` Origin** | `gateway-auth.ts:216` returns `true`; CSRF double-submit is the stated compensating control (`:206-208`) | **P2** — defensible design, but the fail-open direction should be recorded as a decision, not an accident; the same file's other checks fail closed |
| S-3 | **Registry protection fails open if `.serenity` is unreadable** | `guards.ts:99-101` catch → `return false` | **P2** — documented anti-deadlock choice; should be recorded in diagnostics when it triggers |
| S-4 | **Three auth models on four listeners, no unified review point** | §7.1 #6 | **P2** — acceptable while all external faces are opt-in and loopback-bound (ACP 3100, Skiff 3099) or authenticated (gateway 3081 with scrypt+TOTP+lockout+CSRF); needs a single "external faces" document that states the invariant |
| S-5 | **Public-ask key stored in browser `localStorage`** | `acp-http.ts:474,489,494,548` | **P2** — accepted trade-off for a mobile page; the key is a bearer secret with IP-based lockout on failure (`:253-266`) |
| S-6 | **Output guard is the last line for credential leakage, and it degrades silently** | §4.2 #6 | **P1** — a compensating control must not fail quietly |

---

## 8. Prioritized roadmap

| ID | Sev | Gap | One-line fix | Effort | Depends on |
|---|---|---|---|---|---|
| **R-01** | **P0** | `readDshVersion()` reads disk, not the running host; nothing verifies the live contract (Gap B) | Add `src/host/contract.ts` + `probeHost(ctx)` at mount; record result; expose in `dashboard health` | 1–1.5 d | — |
| **R-02** | **P0** | Host access scattered over 37 files / 35 `as unknown as`; drift cannot fail loudly (Gap A) | Extract `src/host/` accessors + event enum + `sessionEvents`; delete the 2 duplicate copies | 1–1.5 d | — |
| **R-03** | **P0** | Guard seams fail open silently: corrupt `serenity.json` → empty blacklist; unreadable credential table → weaker output guard (Gap C, §4.2 #1/#6) | Make guard-input failures loud + recorded; never degrade a guard without reporting | 0.5 d | R-02 (sink) |
| **R-04** | **P1** | Credential hard-block bypassable via symlink / non-safe-mode bash (S-1) | `realpath` in `decideGuard`; deny credential paths in bash command strings | 0.5 d | — |
| **R-05** | **P1** | No real-host contract test; all 53 test files use self-authored doubles | New vitest project booting a minimal host: tools register, events exist, `snapshotEvents` is a function, settings section installs | 1–2 d | R-01 |
| **R-06** | **P1** | Spec §10 error contract unimplemented (F-01) | `SerenityError` + `serenityCode` for the 13 classes; map existing throw sites | 1 d | — |
| **R-07** | **P1** | Failure policy undefined; 121 `catch` sites unaudited (Gap C) | Write the policy (host violation = loud / user data = visible degrade); add a lint-style test requiring every catch to rethrow, record, or be marked best-effort | 0.5 d + audit | R-02 |
| **R-08** | **P1** | Unified diagnostics absent; two ad-hoc files (§5) | `host/diagnostics.ts` → `AGENT_SESSIONS/.acc-diag.json`; migrate the two existing files | 1 d | R-02 |
| **R-09** | **P1** | `dashboard health` cannot answer "is dsp healthy?" (Gap E) | Add `host` / `seams` / `faces` / `config` sections fed by the boundary + sink | 0.5 d | R-01, R-08 |
| **R-10** | **P1** | Four config stores, no ownership table (F-02, §7.1 #1) | Publish key→store ownership table; test that each runtime key resolves from one store | 0.5 d | — |
| **R-11** | P2 | Threshold default 150 vs spec 100 (F-03) | Align to 100 or amend the spec with a recorded decision | 15 min | — |
| **R-12** | P2 | ACK code sequential `K<n>` vs spec 3-char random (F-04) | Random 3-char code; keep single-use semantics | 1 h | — |
| **R-13** | P2 | toolsBlock under-declares `container_git` (F-06) | Add pull/diff to the Tools line | 15 min | — |
| **R-14** | P2 | Persona displaces the EAP block, breaking I5 (F-05) | Move persona to an appended block, or exempt it in the spec | 2 h | — |
| **R-15** | P2 | Duplicated session/assistant-text extractors (§7.1 #4/#5) | Single shared helper; delete the two local copies | 2 h | R-02 |
| **R-16** | P2 | Two divergent write-tool predicates (`ccc.ts:357` vs `guards.ts:114`) | One predicate, action-aware; delete the other | 1 h | — |
| **R-17** | P2 | Three session-restore paths, winner unrecorded (§7.1 #3) | Record the winning path in diagnostics + Session block | 3 h | R-08 |
| **R-18** | P2 | Idempotence via in-process `Set` (§7.1 #2, F-14) | Derive "already seeded" from a persisted session event | 3 h | R-02 |
| **R-19** | P2 | Boundary erosion risk | Mechanical test: no `as unknown as` / `cordis` / `@deepseek-ai/dsh-*` imports outside `src/host/` and `src/client/` | 2 h | R-02 |
| **R-20** | P2 | External faces lack a single invariant statement (§7.3 #6, S-4/S-5) | One "external faces" doc: listener, auth model, bind address, opt-in flag | 1 h | — |

**Sequencing:** R-01/R-02/R-03 are the P0 core and are independent of everything else; do them first and
together (one migration). R-05/R-08/R-09 then convert the boundary into visible, testable health. R-04 and
R-06 are independent and can run in parallel. Everything P2 is cheap hygiene once the boundary exists —
several items (R-15/R-16/R-18/R-19) become nearly free because the duplication is deleted rather than fixed.

---

## 9. Method & limits

**Read (full or targeted):** spec `AI_LAB/serenity-acc-specs/README.md` (814 lines, §0–§11 + appendix A);
`src/index.ts`, `invariant.ts`, `constants.ts`, `ccc.ts`, `kit-ops.ts`, `status.ts`, `session-ops.ts` (head),
`config-ops.ts` (head), `output-guard.ts` (head), `trajectory-assistant.ts`, `settings-section.ts`,
`seams/system-prompt.ts` (head + Session block + assembly), `seams/context.ts`, `seams/keeper.ts` (head),
`seams/guards.ts` (protection + decideGuard), `fs-ops.ts` (write path), `tools/handyman.ts` (events),
`skiff-core.ts` (events), `client/image-fallback-api.ts` (head), `api.ts` (upload path),
`gateway-auth.ts` (CSRF/Origin), `acp-http.ts` (key gate), `dsh.plugin.json`, `package.json`,
`docs/review/slice-G-declaration-surface.md`, `.opencode/skills/dsh-serenity-plugin-development/SKILL.md`.

**Greps (counts reported above):** `as unknown as` (35); `catch {` (121); `throw new Error(` (150);
`serenityCode|E-*-NNN` (0); host imports `from 'cordis'|from '@deepseek-ai/dsh-` (37 files);
`snapshotEvents` in `tests/` (46 matches, all doubles); `from '@deepseek-ai/dsh-` in `tests/` (**0**);
host-side `engines|manifest|contributes` under `packages/host` (0 plugin-manifest enforcement);
host-side `export const version|hostVersion|dshVersion` (0 runtime version export); registry-protection
call sites (12); diag/console sites (97).

**Limits — not verified in this slice:**
- No build/test/typecheck was run (read-only slice; bash disabled). Counts are textual, not compiled.
- The host contract list in §3/§6 is derived from dsp's *usage* plus spot-checks against
  `tool-cordis/src/api-catalog.ts` and `core/session`; a complete host API inventory is slice C/E work.
- Whether `dsh.client.inject` must enumerate every consumed client package (slice G, G-6) is unresolved here.
- The 121 `catch` sites were classified by pattern, not audited one by one; §4.2 lists the 10 worst, and a
  full audit is R-07.
- Security findings are architectural (reachability-based), not exploited; no proof-of-concept was run
  (bash disabled).
- `AI_LAB/dsh-harness-public` was read for contract shape only, not audited for its own correctness.

**No source was modified.** This slice wrote exactly one file:
`AI_LAB/dsh-serenity-plugin/docs/review/slice-F-architecture-gaps.md`.
