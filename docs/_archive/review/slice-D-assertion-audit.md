# Slice D — Type-Assertion Bypass Audit (dsp vs DSH 0.1.2-rc.1)

Scope: `AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/src/` (dsp v1.30.5), verified against host
`AI_LAB/dsh-harness-public` @ 0.1.2-rc.1. Read-only slice: no source modified, no fix applied.

Motivating failure mode (host removed `Session.events` → `snapshotEvents()`, dsp read `.events` through
`as unknown as`, `tsc` green, runtime silently `undefined`, tests green because doubles still exposed
`.events`). This slice asks, for every assertion site: **if the host shape drifts again, does dsp fail
loudly or silently?**

---

## 1. Summary

| Metric | Count |
|---|---|
| Total assertion sites found (explicit + structural) | **80** |
| — explicit (`as unknown as`) | 38 |
| — structural (`as { … }` / `as never`) | 42 |
| `as any` sites | **0** |
| `@ts-expect-error` / `@ts-ignore` | **0** |
| Non-null `!` in host-facing code | 1 (`config-ops.ts:441`, locally guarded) |
| `catch (err: any)` | 12 (error-message formatting only) |
| Host-facing sites (target is a host type/service/prop) | **32 / 38** explicit; 42 / 42 structural |
| Silent failure mode (drift yields `undefined` / falsy / no-op instead of a throw) | **38 / 38** explicit; 42 / 42 structural |
| Sites where a test would catch host-shape drift | **0 / 80** |
| Sites where a test *actively certifies* the wrong shape | **2** (`acp-core.test.ts:80,93`; `weixin.test.ts:433,447`) |
| Assertions provably unnecessary against rc.1 types | **17** (14 already typed via an existing dsp import; 3 need only one type-only import or a dependency bump) |
| Assertions justified by a genuinely unavailable host type | **9** (D-03, D-19, D-26, D-27, D-33, D-34, D-18, plus D-25/D-37 which are unavailable *in the program* — see below) |

**Headline findings**

1. **`acp-core.ts:187` is a live, already-shipped silent failure** — the same failure mode as the
   motivating bug, not a hypothetical. `agent.interrupt?.()` targets a member the host `Agent` does not
   have, and a dsp unit test *supplies* that member on its fake, so the test certifies the no-op.
2. The bypass is **systemic, not incidental**: 80 sites, of which **17** re-declare shapes the host already
   exports against the rc.1 types dsp targets. Those 17 assertions buy nothing and remove `tsc`'s only
   protection against the exact drift class that motivated this slice.
3. **Zero drift detection.** No dsp test imports a real host type, boots a `cordis.yml`, or constructs a
   real `Session`/`Agent`/`Context`; every test hand-writes the double. Where the double disagrees with the
   host, the test is a false witness (finding 1).
4. The optional-service lookup pattern (`ctx.get?.('x')`) is **mostly disciplined** — 11 of 13 lookups
   are guarded before use. The genuine gaps are listed in §4.

---

## 2. Full site table

### 2.A Explicit assertion sites (`as unknown as`) — 38 sites

Columns: asserted shape | target | drift failure mode (`loud` = throws/type error/explicit guard;
`silent-guarded` = degrades without error but guarded and logged; `silent-unchecked` = wrong behavior, no signal) |
why it exists | verdict | test catches drift?

| ID | Site | Asserted shape | Target | Drift failure mode | Why it exists | Verdict | Test catches drift? |
|---|---|---|---|---|---|---|---|
| D-01 | `src/acp-core.ts:187` | `{ interrupt?: () => void }` | **HOST `Agent`** | **silent-unchecked — member does not exist today; `?.()` is a permanent no-op while the method returns `{cancelled:true}`** | (d) written against an assumed API | **REPLACE** → `agent.cancel({ kind: 'user' })` (`packages/core/session/src/types.ts:181`; `Agent.cancel` at `packages/core/agent/src/runtime-types.ts:91`) | **No — and `tests/acp-core.test.ts:80,93` supplies `interrupt` on the fake, certifying the no-op** |
| D-02 | `src/api.ts:168` | `ctx.sessions as { list?: () => Array<{header?:{cwd?:string}}> }` | HOST `SessionStore` (typed, peerDep `dsh-session`) | silent-unchecked — `?? []` → `resolveWorkspace` falls back to `process.cwd()` → wrong CCC resolved | (b) convenience | **REPLACE** → `ctx.sessions.list()` (`packages/core/session/src/index.ts:1127`, `Context.sessions` decl `:37`) | No (`tests/workspace-resolve.test.ts` fakes ctx) |
| D-03 | `src/api.ts:335` | `ctx.get?.('workspaceRegistry') as { list?: () => Array<{path?:string;title?:string}> }` | HOST optional service (`dsh-workspace` not a dsp dep) | silent-unchecked → `knownWorkspaces: []` → whitelist dropdown silently empties; an empty whitelist can then be saved | (a) type unavailable | **TIGHTEN** (keep lookup, add `typeof registry.list === 'function'` guard + one-time warn) | No (`tests/config-ops.test.ts:185` tests the pure projector only) |
| D-04 | `src/api.ts:351` | `{ emit?: (name, payload?) => void }` | HOST cordis `Context.emit` (exists, `vendor/cordis/src/events.ts:194`) | silent-unchecked — `?.` swallows absence → gateway never rebuilt after a config PUT (stale listeners) | (b) defensive `?.` | **TIGHTEN** (drop `?.`; `emit` is guaranteed) | No |
| D-05 | `src/autopilot-trajectory.ts:417` | `{ sessions?: { list?: () => Array<unknown> } }` | HOST `SessionStore` | silent-unchecked → empty candidate pool → reports "无 live 会话" (misleading diagnostic) | (b) | **REPLACE** → `ctx.sessions.list()` | No |
| D-06 | `src/autopilot-trajectory.ts:418` | `{ agents?: { get?: (id: string) => Agent \| undefined } }` | HOST `AgentRegistry` (typed, peerDep `dsh-agent`) | silent-unchecked → `undefined` → target agent never steered | (b) + brand escape (`string` vs `SessionId`) | **REPLACE** → `ctx.agents.get(id as SessionId)` | No |
| D-07 | `src/autopilot-trajectory.ts:491` | `{ sessions?: { list?: () => Array<unknown> } }` | HOST `SessionStore` | silent-unchecked → diagnostic returns "无 live 会话" instead of the real cause | (b) | **REPLACE** | No |
| D-08 | `src/autopilot-trajectory.ts:506` | `{ agents?: { get?: (id: string) => Agent \| undefined } }` | HOST `AgentRegistry` | silent-unchecked; note `sess.id ?? ''` would call `get('')` | (b) + brand escape | **REPLACE** | No |
| D-09 | `src/autopilot-trajectory.ts:525` | `{ sessions?: { list?: () => Array<{header?:{cwd?:string}}> } }` | HOST `SessionStore` | silent-unchecked → falls back to `process.cwd()` root | (b) | **REPLACE** | No |
| D-10 | `src/autopilot-trajectory.ts:626` | `{ sessions?: { list?: () => Array<{id?:string;header?:{cwd?:string}}> } }` | HOST `SessionStore` | silent-unchecked → `listLiveSessions()` returns `[]` → panel shows nothing | (b) | **REPLACE** | No |
| D-11 | `src/client/FileFallbackDock.tsx:41` | `{ input?: { draft?: string } }` | HOST client props (`PropsRuntime<'conversation.input.dock'>`) | silent-unchecked → draft never appended (paste fallback dies quietly) | (a)/(c) provide-channel value not in the typed props share | **TIGHTEN** (single guard + warn when `input` absent) | No (`tests/file-fallback.test.ts` feeds plain stubs) |
| D-12 | `src/client/FileFallbackDock.tsx:44` | `{ inputActions?: { setDraft } }` | HOST client provide channel | silent-unchecked → uploaded file has no draft write-back | (a)/(c) | **TIGHTEN** | No |
| D-13 | `src/client/ImageFallbackDock.tsx:57` | `{ session: SessionLike; input?: InputLike }` | HOST client props | silent-unchecked → fallback never triggers | (a)/(c) | **TIGHTEN** | No |
| D-14 | `src/client/ImageFallbackDock.tsx:63` | `{ inputActions?: InputActionsLike }` | HOST client provide channel | silent-unchecked → rail not cleared / text not resubmitted | (a)/(c) | **TIGHTEN** | No |
| D-15 | `src/config-ops.ts:216` | `settings as unknown as StoreShape` | dsp-internal (`AdvancedSettings` → file store) | silent-unchecked → wrong keys written to `~/.dsh/serenity-hooks.json` | (b) two parallel interfaces | **TIGHTEN** (make `StoreShape` a mapped/superset type) | No |
| D-16 | `src/fs-ops.ts:239` | `{ path; entries; count } as unknown as JsonValue` | dsp-internal | silent-unchecked → tool result field renamed unnoticed | (b) | **TIGHTEN** (declare the return type at the boundary) | No |
| D-17 | `src/fs-ops.ts:278` | `{ path; entries; maxDepth } as unknown as JsonValue` | dsp-internal | same as D-16 | (b) | **TIGHTEN** | No |
| D-18 | `src/gateway-dsh-auth.ts:77` | `{ writeHead; end } as unknown as ServerResponse` | HOST `connection.authorizeIndex` response | silent-guarded — in-process double; if the host reads another member the cookie exchange returns `undefined` → gateway 401 loop (logged once) | (a) a real `ServerResponse` cannot be built in-process | **KEEP**, but retarget the assertion to the host's actual 2-member interface (`ConnectionIndexResponse`, `packages/client/connection/src/rpc.ts:94-97`) instead of node's `ServerResponse` — the object already satisfies it structurally | No (`tests/gateway-dsh-auth.test.ts` fakes the connection) |
| D-19 | `src/gateway.ts:566` | `{ get?: (name) => unknown }` → `connection` | HOST optional service (`dsh-client-connection` not a dep) | **silent-guarded (exemplary)** — explicit `typeof` checks + one-time log, returns `undefined` | (a) type genuinely unavailable | **KEEP** (reference implementation for the other `ctx.get` sites) | No |
| D-20 | `src/gateway.ts:607` | `{ get?: (name) => unknown }` → `webServer` as `{ port?: number }` | HOST `WebServer` (typed, optional peerDep `dsh-host-webserver`) | silent-unchecked — `if (!webServer?.port) return` exits **without any log** → gateway never starts | (b) — the type *is* available (`ctx.webServer.port` is a typed getter, `packages/host/webserver/src/index.ts:150`) | **REPLACE** → `ctx.get('webServer')` (or `ctx.webServer`; `api.ts:184` already uses it directly) | No |
| D-21 | `src/index.ts:223` | `{ sessions?: { list?: () => Array<{header?:{cwd?:string}}> } }` | HOST `SessionStore` | silent-unchecked → skiff root resolution falls through to `process.cwd()` → wrong CCC bound | (b) | **REPLACE** | No |
| D-22 | `src/index.ts:248` | `{ webServer?: { port?: number } }` | HOST `WebServer` | silent-guarded → falls back to port 3080 (hardcoded) | (b) — type available | **REPLACE** | No |
| D-23 | `src/msm-ops.ts:643` | `protocol.list as unknown as JsonValue` | dsp-internal (`PreparedExec.protocol`) | silent-unchecked → protocol payload shape drift unnoticed | (b) | **TIGHTEN** | No |
| D-24 | `src/msm-ops.ts:644` | `protocol.schema as unknown as JsonValue` | dsp-internal | same as D-23 | (b) | **TIGHTEN** | No |
| D-25 | `src/rebuild.ts:372` | `ctx.get?.('sessionTitle') as { rename? }` | HOST typed service — **type unavailable in the program**: `dsh-session-title` is a peerDep (`package.json:62`) but no dsp file imports it, so its `interface Context` augmentation never loads | silent-guarded — warns `sessionTitle 服务不可用` and skips the rename | (a) augmentation not loaded | **REPLACE** → add `import type {} from '@deepseek-ai/dsh-session-title'` (as `api.ts:18` already does for `dsh-host-webserver`) and call `ctx.sessionTitle.rename(...)` | No (`tests/rebuild.test.ts:433` fakes it) |
| D-26 | `src/rebuild.ts:414` | `ctx.get?.('tokenMeter') as { estimateMessage? }` | HOST optional service (`dsh-token-meter` not a dep) | silent-guarded — falls back to no shadow-price accounting | (a) + (c) optional-at-apply-time | **TIGHTEN** | No |
| D-27 | `src/seams/keeper.ts:110` | `ctx.get?.('sessionProjections') as { snapshot? }` | HOST optional service (`dsh-session-projection` not a dep) | silent-guarded → `null` → keeper loses token pressure → **rebuild reminders stop firing silently** | (a) + (c) | **TIGHTEN** (guard `typeof snapshot === 'function'`; log once when absent) | No (`tests/keeper.test.ts:112` pins the fake shape) |
| D-28 | `src/session-bound.ts:113` | `{ append: (type, data) => unknown }` | HOST `Session` (typed, peerDep) | silent-unchecked (pre-guard at `:111` only checks existence) | (b) union parameter to admit test doubles | **REPLACE** → accept `Session`; dsp already declares `serenity/bound` in `SessionEventMap` (`src/session-bound.ts:27-28`), so the typed `append<T extends SessionEventType>` (`packages/core/session/src/index.ts:668`) accepts it | No (`tests/session-bound.test.ts:71` pins the legacy double) |
| D-29 | `src/settings-section.ts:150` | `get as unknown as () => SerenitySimpleSettings` | HOST `SettingsProvider` hook contract | silent-unchecked → settings source typed wrong → panel shows wrong values | (b) generic-heavy host signature | **TIGHTEN** | No |
| D-30 | `src/settings-section.ts:158` | `{ emit?: (name, payload?) => void }` | HOST `Context.emit` | silent-unchecked → settings change never propagates to gateway | (b) | **TIGHTEN** (drop `?.`) | No |
| D-31 | `src/settings-section.ts:164` | `ctx.settings as { installSection(…) } \| undefined` | HOST typed service — `SettingsProvider` **is** imported (`settings-section.ts:25`) so `ctx.settings` is typed (`packages/settings/settings/src/index.ts:145`; `installSection` at `:472`) | **silent-unchecked — assertion fails → falls through to `:181-183`, the "no settings provider" branch → the Serenity settings section is never installed and every toggle silently no-ops** | (d) documented cross-version shim: `:21-23` states the installed types lacked `installSection`, to be dropped once on rc.1 — **that condition is now met, so the shim is stale** | **REPLACE** → `ctx.settings.installSection(...)`; make the `:181-183` fallback `console.warn` instead of silent; add `@deepseek-ai/dsh-settings` to peerDependencies | No (`tests/settings-section.test.ts` fakes ctx) |
| D-32 | `src/skiff-core.ts:248` | `{ agents?: { get?: (id: string) => Agent \| undefined } }` | HOST `AgentRegistry` | silent-unchecked → `undefined` → "unknown session (not recoverable)" even though the agent is live | (b) + brand escape | **REPLACE** | No |
| D-33 | `src/skiff-debug.ts:89` | `ctx.get?.('workspaceRegistry') as { list? }` | HOST optional service | silent-guarded → candidate discovery degrades to layer ② | (a) | **TIGHTEN** | No (`tests/skiff-debug.test.ts:88` fakes ctx) |
| D-34 | `src/skiff-debug.ts:99` | `ctx.get?.('sessionPersistence') as { list?: () => Promise<…> }` | HOST optional service | silent-guarded → degrades to layer ③ | (a) | **TIGHTEN** | No |
| D-35 | `src/skiff-debug.ts:110` | `{ sessions?: { list?: () => Array<{header?:{cwd?:string}}> } }` | HOST `SessionStore` | silent-unchecked → CCC list empty → panel shows no CCCs | (b) | **REPLACE** | No |
| D-36 | `src/tools/handyman.ts:353` | `results.map(...) as unknown as JsonValue` | dsp-internal | silent-unchecked → job result fields renamed unnoticed by the model | (b) | **TIGHTEN** | No |
| D-37 | `src/tools/session.ts:184` | `ctx.get?.('sessionTitle')` (cast downstream at `:193`) | HOST typed service — same unavailable augmentation as D-25 | silent-guarded — `renameDshSessionOnUse` reports `sessionTitle service unavailable` | (a) augmentation not loaded | **REPLACE** (same fix as D-25) | No |
| D-38 | `src/weixin-bridge.ts:398` | `ctx.sessions as { list?: () => Array<{header?:{cwd?:string}}> }` | HOST `SessionStore` | silent-unchecked → no CCC discovered → **weixin bridges silently do not start** | (b) | **REPLACE** | **No — `tests/weixin.test.ts:433,447` supplies `interrupt` on its fake, certifying the same wrong shape as D-01** |

### 2.B Structural assertion families (`as { … }` / `as never`) — 42 sites

These re-declare host shapes that the host already exports and dsp already depends on. Each family is one
finding; the full site list is given so the family is auditable. Every member is `silent-unchecked` on drift.

| ID | Family (asserted shape) | Target | Sites (42) | Verdict |
|---|---|---|---|---|
| S-01 | `agent.session as { header?: { cwd?: string } }` | HOST `Session.header: SessionHeader` (**typed**, `packages/core/session/src/types.ts:92,104`; `Session.header` at `core/session/src/index.ts:443`) | `seams/env.ts:42`, `seams/context.ts:150,232`, `seams/compact.ts:60`, `seams/system-prompt.ts:545`, `rebuild.ts:450`, `output-guard-seam.ts:64`, `tools/handyman.ts:49` | **REPLACE** — all fall back to `process.cwd()`; a rename would silently mis-scope every guard to the wrong CCC |
| S-02 | `agent.session as { id?: string }` | HOST `Session` (id typed) | `seams/context.ts:98,102,114`, `seams/guards.ts:267`, `seams/system-prompt.ts:551,600,603`, `seams/compact.ts:55`, `skiff-core.ts:111,465`, `output-guard-seam.ts:61`, `seams/bootstrap.ts:119,166`, `tools/handyman.ts:337` | **REPLACE** |
| S-03 | `session as { header?: { delegationDepth?: number } }` | HOST `SessionHeader.delegationDepth` (**typed**, `core/session/src/types.ts:122`) | `seams/bootstrap.ts:169` | **REPLACE** |
| S-04 | `session as { snapshotEvents?: …; events?: … }` (dual-form event reader) | HOST `Session.snapshotEvents()` (typed) + legacy `.events` | `session-ops.ts:53`, `skiff-core.ts:386`, `tools/handyman.ts:77`, plus the test-side copy `tests/autopilot-trajectory.test.ts:53` | **TIGHTEN** — the `.events` fallback is precisely what hid the motivating bug. Prefer `snapshotEvents`; if the fallback stays, it must be *removed from test doubles* so no test can pass on the legacy shape. **Three duplicated implementations** (`session-ops.ts` documents itself as the convergence point; `skiff-core.ts:382` admits it is a copy) — entropy, not just risk |
| S-05 | `session.append(...) as never` (event payload) | HOST `Session.append<T extends SessionEventType>` (typed) | `rebuild.ts:344,351,354` | **TIGHTEN** — `as never` disables the event-payload check for `compaction/prune` and `user/message`; `user/message.source` is a required field (`rebuild.ts:349-350` documents a past `TypeError` from exactly this) |
| S-06 | `ctx.tools.get('run_code', scope as never)` | HOST `ToolRegistry.get(name, scope?)` (**typed**, `packages/core/tools/src/index.ts:1195`) | `seams/system-prompt.ts:523` | **TIGHTEN** — `as never` erases the scope type; wrapped in try/catch so drift is silent (`''` → Code Mode line omitted) |
| S-07 | `agent as { session?; inbox? }` | HOST `Agent.session` / `Agent.inbox` (**typed**, `runtime-types.ts:76,78`) | `seams/bootstrap.ts:158,237,284,302` | **REPLACE** — `bootstrap.ts:302` `inbox.prepend` also asserts a method the host `Inbox` type may not expose |
| S-08 | `{ prepend: true } as never` (listener options) | HOST cordis `ctx.on` options | `seams/bootstrap.ts:402` | **TIGHTEN** |
| S-09 | `ctx.sessions as { get?: (id: SessionId) => Session \| undefined }` | HOST `SessionStore.get` (typed) | `api.ts:163`, `rebuild.ts:274` | **REPLACE** — both guarded downstream (D-02 pattern, but these two *do* check: `rebuild.ts:276` throws loud) |
| S-10 | `ctx.agents as { resume?: … }` | HOST `AgentRegistry.resume` (**typed**, `core/agent/src/index.ts:418`; `ResumeAgentOptions` at `:132`) | `skiff-core.ts:301` | **REPLACE** — the comment justifies the assertion as a `this`-binding fix, but calling `ctx.agents.resume({...})` directly preserves `this`; the assertion is not what fixes it |
| S-11 | `ctx.sessions.binding(sessionId as never) as { session?: { prompt? } }` | HOST client `ClientSessions.binding` | `client/image-fallback-api.ts:103` | **TIGHTEN** — guarded (throws at `:105`), so drift is loud; `as never` still erases the branded id |
| S-12 | `props as unknown as { … }` (client provide channel) | HOST client props shares | `client/FileFallbackDock.tsx:41,44`, `client/ImageFallbackDock.tsx:57,63` | **TIGHTEN** (see D-11…D-14) |

---

## 3. Top-5 highest risk

Severity: **P0** = already broken in production / silent no-op on a shipped path; **P1** = silent
capability loss with no operator signal; **P2** = silent degradation with a visible symptom.

### 1. D-01 — `src/acp-core.ts:187` — **P0** — host member does not exist

- **Asserted:** `(agent as unknown as { interrupt?: () => void }).interrupt?.()`
- **Host truth:** `Agent` has **no `interrupt`**. It has `cancel(cause: AgentCancelCause, options?: CancelOptions): void`
  (`packages/core/agent/src/runtime-types.ts:91`; causes at `packages/core/session/src/types.ts:181-185`).
  `interrupt` exists only on the subagent service with a different signature
  (`ctx.subagents.interrupt(targetSessionId, authority)`, `packages/subagent/subagent/src/index.ts:293`).
- **What breaks:** `session/cancel` over ACP returns `{ cancelled: true }` and cancels nothing. An ACP client
  (or the Skiff UI) that believes it stopped a run does not stop it. This is the motivating bug's exact
  signature: green `tsc`, green tests, silent wrong runtime.
- **How it would be noticed:** only by a user observing that a cancelled prompt keeps streaming. There is no
  log, no error, no metric — `acp-core.ts:188-190` swallows the (impossible) throw.
- **Why tests miss it:** `tests/acp-core.test.ts:80` declares the fake as
  `{ …; interrupt?: () => void }` and `:93` implements it, so `session/cancel` is asserted green against a
  member the host lacks. The double is a false witness, exactly as with `.events`.
- **Minimal guard:**
  ```ts
  const cancel = (agent as { cancel?: (cause: { kind: 'user' }) => void }).cancel
  if (typeof cancel !== 'function') return { cancelled: false }   // loud: report what actually happened
  agent.cancel({ kind: 'user' })
  return { cancelled: true }
  ```
  Then change the test double to expose `cancel` (and assert `cancelled: false` when it is absent).

### 2. D-31 — `src/settings-section.ts:164` — **P1** — assertion collapses a typed service into a silent fallback

- **Asserted:** `ctx.settings as { installSection(…) } | undefined`
- **Host truth:** `ctx.settings: SettingsProvider` is declared (`packages/settings/settings/src/index.ts:145`)
  and `installSection<const Namespace extends string, T>(…)` is a public method (`:472`).
- **What breaks:** if the asserted member shape ever mismatches (method renamed, argument order changed), the
  `if (settingsAny)` test at `:169` still passes — the object exists — and the call at `:171-178` throws into
  no handler, **or**, if the property read yields `undefined`, control falls to `:181-183` and the plugin
  silently runs in "no settings provider" mode. Result: the Serenity settings section never installs; every
  toggle (safe mode, skiff, ACP, gateway) silently does nothing, with no error anywhere.
- **Note on the documented reason:** `:21-23` justifies the assertion as a cross-version shim ("installed
  types lack `installSection`; drop it once on rc.1"). That condition is now met — rc.1 declares
  `installSection` (`packages/settings/settings/src/index.ts:472`) and dsp already imports `SettingsProvider`
  (`:25`) — so the shim is stale and now only removes type protection.
- **How it would be noticed:** the WebUI settings page is simply absent; the operator has no reason to suspect
  the plugin rather than DSH.
- **Minimal guard:** call the typed API — `ctx.settings.installSection(ctx, SERENITY_SETTINGS_NS, …)` — add
  `@deepseek-ai/dsh-settings` to peerDependencies, and replace `:181-183` with a
  `console.warn('[serenity-hooks] settings provider 不可用 — Serenity 设置页未装配')`.

### 3. D-27 — `src/seams/keeper.ts:110` — **P1** — silent loss of the context keeper

- **Asserted:** `ctx.get?.('sessionProjections') as { snapshot?: (s) => { values?: … } }`
- **Host truth:** `ctx.get(name, strict?)` exists and returns `undefined` when unprovided
  (`vendor/cordis/src/reflect.ts:19,233-235`); `sessionProjections` is a real service
  (`packages/session/session-projection/src/index.ts:31`) whose `snapshot(session).values.contextPressure`
  is consumed by the host's own token meter (`packages/llm/token-meter/src/index.ts:100,108`).
- **What breaks:** the `if (!projections) return null` guard means a shape drift (e.g. `snapshot` →
  `snapshotOf`, or the projection key renamed) yields `null` on every call. `readContextPressure` then always
  returns `null`, so the keeper never sees token pressure and **never emits the rebuild reminder**. The ACC's
  central hygiene mechanism (rebuild before context exhaustion) stops firing with no signal at all.
- **How it would be noticed:** sessions silently run into compaction/context limits without the S###-rebuild
  prompt — visible only as degraded behaviour over hours, never as an error.
- **Minimal guard:** keep `ctx.get('sessionProjections')`, add
  `if (typeof projections.snapshot !== 'function') { warnOnce(...); return null }`, and assert
  `typeof pressure.projectedTokens === 'number'` (already present at `:114`).

### 4. D-20 — `src/gateway.ts:607` — **P1** — gateway never starts, with no log

- **Asserted:** `ctx.get?.('webServer') as { port?: number } | undefined`
- **Host truth:** `ctx.webServer: WebServer` is declared (`packages/host/webserver/src/index.ts:23-24`) and
  `get port(): number` is a typed getter (`:150`). `@deepseek-ai/dsh-host-webserver` is already an (optional)
  peerDependency (`package.json:59,73`), so the type is available — and `src/api.ts:184` already calls
  `ctx.webServer.register(...)` directly twelve times without any assertion.
- **What breaks:** `if (!webServer?.port) return` at `:610` exits `sync()` **without logging**. Any drift in the
  lookup name or the `port` accessor turns the whole reverse-proxy gateway into a permanent no-op that looks
  identical to "gateway disabled in settings". Contrast D-19 (`connection`), which logs its absence once —
  the same file, two different standards.
- **How it would be noticed:** only by a user finding `http://<host>:<port>` dead.
- **Minimal guard:** use the typed service (`ctx.get('webServer')`, no assertion) and add the same one-time
  `console.log('… webServer ✗ 不可取')` pattern already used at `:570-573`.

### 5. D-03 — `src/api.ts:335` — **P1** — whitelist projection silently empties

- **Asserted:** `ctx.get?.('workspaceRegistry') as { list?: () => Array<{ path?: string; title?: string }> }`
- **Host truth:** `workspaceRegistry: WorkspaceRegistry` (`packages/workspace/workspace/src/index.ts:68-70`);
  the host's own e2e suites use `.list()` (`apps/web/tests/workspace-management.e2e.ts:147,173`).
- **What breaks:** `registry?.list?.() ?? []` at `:338` swallows both a missing service and a renamed method
  into an empty list. `/serenity/config` then answers `knownWorkspaces: []`, the AccountsEditor whitelist
  dropdown empties, and — because `projectKnownWorkspaces` (`config-ops.ts:435`) treats an empty
  `allowPrefixes` as "allow all" — a user can save an empty whitelist believing they were editing a list that
  existed. The try/catch at `:339-341` deliberately keeps this silent.
- **How it would be noticed:** the dropdown is empty; the operator has no way to distinguish "no workspaces
  registered" from "the lookup broke".
- **Minimal guard:** guard on `typeof registry.list === 'function'` and `console.warn` when absent, mirroring
  D-19's pattern.

*Also flagged (P2):* D-05/D-06/D-07/D-08/D-10 (autopilot target resolution returns misleading diagnostics
instead of the real cause), D-38 (`weixin-bridge` silently starts no bridge), D-28/S-04 (the `.events`
fallback keeps the motivating bug's shape alive in doubles).

---

## 4. Optional-service unchecked accesses

`ctx.get(name)` is the host-sanctioned accessor for optional services and returns `undefined` when
unprovided (`vendor/cordis/src/reflect.ts:233-235`; policy: `packages/AGENTS.md`, "Optional services use
`ctx.get(name)`"). dsp has **13** such lookups. 11 are checked; the results are not used blindly:

| Site | Lookup | Checked before use? |
|---|---|---|
| `seams/keeper.ts:110` | `sessionProjections` | Yes — `if (!projections) return null` (`:111`); **shape not checked** |
| `api.ts:335` | `workspaceRegistry` | Partial — `registry?.list?.() ?? []` (`:338`); absence indistinguishable from empty |
| `api.ts:351` | `emit` (event) | **No** — `?.` fire-and-forget; a missing emitter means the config change never propagates |
| `gateway.ts:566` | `connection` | Yes — `typeof` checks + one-time log (`:569-574`) |
| `gateway.ts:607` | `webServer` | Yes — `if (!webServer?.port) return` (`:610`); **no log** |
| `rebuild.ts:372` | `sessionTitle` | Yes — `typeof rename !== 'function'` → warn (`:375-378`) |
| `rebuild.ts:414` | `tokenMeter` | Yes — `typeof estimateMessage === 'function'` (`:418`) |
| `skiff-debug.ts:89` | `workspaceRegistry` | Partial — `?? []` (`:92`) |
| `skiff-debug.ts:99` | `sessionPersistence` | Partial — `(await sp?.list?.()) ?? []` (`:102`) |
| `settings-section.ts:158` | `emit` (event) | **No** — `?.` fire-and-forget |
| `settings-section.ts:164` | `settings` | Yes — `if (settingsAny)` (`:169`), but the guard is on the *object*, not the *method* |
| `tools/session.ts:184` | `sessionTitle` | Yes — cast to `… | undefined` and handled downstream (`:190-196`) |
| `acp-core.ts:187` | *(not a service lookup, same pattern)* `agent.interrupt` | **No — the member never exists** (see D-01) |

**Genuine gaps:** `settings-section.ts:164` (object-guarded, method-unguarded — D-31), `api.ts:335` and
`skiff-debug.ts:89/99` (absence collapsed into an empty collection), `gateway.ts:607` (silent early return),
and `acp-core.ts:187` (optional-call on a nonexistent member — the one true P0).

**Non-null `!` in host-facing code:** exactly one — `config-ops.ts:441,442` `w.path!.startsWith(p)`. It is
runtime-safe because the preceding `.filter()` at `:440` already proves `typeof w.path === 'string'`, but the
proof is not expressed as a type predicate, so the `!` is load-bearing for the compiler only. Rewrite as
`.filter((w): w is { path: string; title?: string } => typeof w.path === 'string' && w.path !== '')` and drop
both `!`. The other two `!` sites are internal and guarded (`api.ts:776-777` depends on the omitted
`dryRun` option; `rebuild.ts:155` indexes a non-empty `nodes`).

**`catch (err: any)`** appears 12 times, all in HTTP handler error formatting (`api.ts` ×11, `git-ops.ts` ×1).
It defeats `unknown`-narrowing for error messages but asserts no host shape; out of scope for this slice,
noted for completeness.

---

## 5. Method & limits

**Method.** (1) `grep` for `as unknown as|as any|@ts-expect-error|@ts-ignore` over `src/` → 39 matches,
minus 1 comment line (`session-ops.ts:46`) = 38 explicit sites. (2) A second `grep` for structural
assertions (`ctx.<svc> as {`, `<obj> as {`, `as never`) → 42 further sites; the first-pass
count of "~35" therefore undercounts by more than half. (3) `grep` for `: any`, `!` non-null patterns, and
`SessionEventMap` declarations. (4) Each site read in context (offset reads, not grep-only). (5) Each asserted
shape verified against the host's own declaration: `interface Context` merges, service classes, `Session`,
`Agent`, `AgentRegistry`, `SessionStore`, `SessionHeader`, `WebServer`, `SettingsProvider`,
`ConnectionIndexResponse`, and `vendor/cordis` `Context.get`. (6) dsp `package.json` peerDependencies read to
decide "host type unavailable" vs "host type available but bypassed". (7) All 53 test files scanned for real
host construction and for doubles that supply members the host lacks.

**Limits.**
- Static reading only: `bash` is disabled in this container, so `tsc --noEmit` was **not** run. Claims that an
  assertion is "unnecessary" are derived from the host declarations and dsp's `package.json`, not from a
  compiler run. A follow-up should confirm each REPLACE verdict by deleting the assertion and typechecking.
- The host reference is the in-tree `AI_LAB/dsh-harness-public` checkout; if it differs from the deployed
  rc.1 build, per-site verdicts for unavailable-type sites (D-03, D-18, D-19, D-26, D-27, D-33, D-34,
  D-25, D-37) could shift.
- Scope discipline: this slice wrote exactly one file (this report). No source file, no `SESSION.md`, and no
  registry/config file was modified; no fix was applied.
- Section 2.B groups 42 structural sites into 12 families rather than 42 rows. Every site is listed inline,
  so the grouping is lossless for reconstruction, but per-site "why" is inferred from the family.
- "Test catches drift?" is answered for **host-shape drift**, not for behaviour: a test may cover the code
  path while its hand-written double still encodes the old shape. Under that definition the answer is 0/80.
  Two sites (D-01, D-38) are worse than uncovered — their doubles assert the wrong shape as correct.
- Runtime behaviour was not observed; D-01's "permanent no-op" conclusion rests on the absence of any
  `interrupt` member on `Agent` in the host source (`runtime-types.ts`, `types.ts`) and the absence of a
  host-side alias for it.
