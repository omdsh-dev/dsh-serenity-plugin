# Slice A — Host Event Contracts (dsp vs DSH 0.1.2-rc.1)

> Read-only audit. dsp = `AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/src` (v1.30.5).
> Host = `AI_LAB/dsh-harness-public` @ 0.1.2-rc.1 (`package.json` root version), the exact production host.
> Host event surface source of record: generated catalog `packages/extensions/tool-cordis/src/api-catalog.ts:2876-3397`
> (`EVENT_API`), cross-checked against each `interface Events` declaration site and
> `packages/core/scope/src/scoped-events.generated.ts:10-38`.

## 1. Verdict summary

| Class | Count | Notes |
|---|---|---|
| **Verified OK** | 16 | event name + payload + decision contract + dispatch mode all match rc.1 (section 2) |
| **Drifted** | 2 | A-01 (write-envelope contract: `ignorable`), A-02 (`PreStepDecision` misuse duplicates claimed messages) |
| **Assertion-hidden** | 1 | A-03 (`Agent.interrupt` — member absent, `?.()` permanent no-op) — **already reported as slice-D D-01**; re-confirmed here from the event/lifecycle angle |
| **Missing / leak** | 2 | A-04 (no `agent/disposed` / `session/disposed` coverage), A-05 (no `ctx.effect` teardown for long-lived resources) |
| **Hygiene (P2)** | 3 | A-06 (`as never` on `ctx.on` options), A-07 (three `sessionEvents` copies — **cross-ref slice-D S-04 / slice-F §4-3**), A-08 (redundant casts / `status: string`) |
| **Total findings** | 8 | 1 × P0, 4 × P1, 3 × P2 |
| **Uncovered host extension points** | 18 | section 4 |

**Headline:** every event dsp *does* subscribe to still exists in rc.1 with a matching payload and arity — no
renamed or removed subscription. The two real defects are in the **write path** (A-01) and in the
**decision payload** (A-02), i.e. exactly the motivating-bug class: contracts that typecheck and that no
current test exercises.

## 2. Verified OK

| Event | dsp site | Host declaration site | Contract checked |
|---|---|---|---|
| `agent/session-start` (emit) | `seams/context.ts:219`; `gateway.ts:664` | `packages/core/agent/src/runtime-types.ts:224`; emitted `core/agent-loop/src/index.ts:630` | `payload.agent` ✓; notification not veto ✓; fires once before first turn ✓ |
| `agent/pre-step` (waterfall) | `seams/context.ts:230`; `seams/bootstrap.ts:382` | `runtime-types.ts:238`; innermost continuation `core/agent-loop/src/agent.ts:243-249` | payload `{agent,messages,turn,step,signal}` ✓; `next()` returns `PreStepDecision` ✓; `prepend` option legal (`vendor/cordis/src/events.ts:112-117`) ✓ — **but see A-02 for the returned payload** |
| `tools/pre-execute` (waterfall) | `seams/guards.ts:349` | `packages/core/tools/src/index.ts:144`; `PreToolDecision` `:581-584` | `(exec, next)` arity ✓; `{kind:'allow'|'deny',reason}` ✓; `exec.agent` optional (`:318`) so the `!exec.agent` guard is sound ✓ |
| `tools/post-execute` (waterfall) | `seams/keeper.ts:170` | `core/tools/src/index.ts:167`; `PostToolDecision` `:590-593` | `(exec, result, next)` arity ✓; the `{...downstream, additionalContexts}` / `{kind:'block',feedback,additionalContexts}` shapes are both legal variants ✓ |
| `agent/turn-stopping` (serial) | `rebuild.ts:395`; `output-guard-seam.ts:56` | `runtime-types.ts:285` | `{agent,turn,signal}` ✓; `agent.steer()` inside the listener is the documented mechanism ✓; sync return legal (`Promise<void> | void`) ✓ |
| `session/event` (emit) | `seams/compact.ts:50`; `seams/bootstrap.ts:261` | `packages/core/session/src/index.ts:74` | `(session, event)` argument order ✓; post-commit fire-and-forget ✓ |
| `agent/status` (emit) | `skiff-core.ts:373`; `tools/handyman.ts:67` | `runtime-types.ts:185`; `AgentStatus = 'idle' \| 'running'` `runtime-types.ts:53` | `{agent,status}` ✓; `idle` = no driver active ✓ (dsp's `status: string` is looser than the host union — A-08) |
| `system-prompt/assemble` (waterfall) | `seams/bootstrap.ts:332` | `packages/core/system-prompt/src/index.ts:31` | `(assembly, context, next)` arity ✓; returned `PromptAssembly` authoritative ✓; `context.agent` **is** declared via merge — `core/agent/src/runtime-types.ts:17-22` + set by `core/agent/src/dispatch.ts:174-176` ✓ |
| `agent/inbox/inserted` (emit) | `seams/bootstrap.ts:277` | `runtime-types.ts:193`; `Inbox.prepend` `core/agent/src/inbox.ts:96` | `{agent,message}` ✓; `agent.inbox.prepend('next-turn', msg)` exists ✓; `source:{kind:'plugin',plugin,form:'notice',summary}` is a legal `MessageSource` (`llm/llm/src/message.ts:81-104`) ✓ |
| `session/created` (emit) | `weixin-bridge.ts:412`; `autopilot-trajectory.ts:386` | `core/session/src/index.ts:52` | single `session` arg ✓ |
| `compaction/end` (SessionEventMap) | `seams/compact.ts:51-53`; `seams/bootstrap.ts:137,184` | `packages/compaction/compaction/src/types.ts:72` | `data.error?: string` ✓; success test `!event.data.error` ✓ |
| `compaction/prune` (SessionEventMap) | `rebuild.ts:340-344` | `compaction/src/types.ts:82-89` | `shadowedRange{start,end}` / `shadowedSeqs` / `shadowedTokenCount` field-for-field ✓ |
| `tool/call`, `assistant/message`, `step/start`, `user/message`, `session/title` (SessionEventMap) | `seams/bootstrap.ts:143,146,188,192`; `context.ts:39` | `core/session/src/known-event-types.ts:29,51,54,66,72`; shapes `core/session/src/types.ts:277,287,300,306` | names + `seq` ordering semantics ✓ |
| `ctx.on(name, fn, {prepend:true})` / `{global:true}` | `seams/bootstrap.ts:402` | `vendor/cordis/src/events.ts:106,112-117` | both options exist ✓ (the `as never` cast is unnecessary — A-06) |
| Scope filter admits untagged plugin listeners | all dsp `ctx.on` sites | `packages/core/scope/src/index.ts:170-185` | `scopeOf(pluginCtx) === undefined` ⇒ `return true` ⇒ dsp receives every agent-scoped event ✓ |
| `SettingsSectionHooks` (`setSource`/`onChange`/`validate`) | `settings-section.ts:143-178` | `packages/settings/settings/src/index.ts:472-496, 871-891` | hook names + call order ✓ (also independently confirmed by slice-G) |
| `sessionEvents()` now reads `snapshotEvents()` | `session-ops.ts:52-64` | `core/session/src/index.ts:600-609` | **motivating bug fixed**: `.events` is only a fallback ✓ |
| Attachment error codes | `client/image-fallback-api.ts:32` | `api/session-controller/src/types.ts:194` (`session/attachment-invalid`), `subagent/subagent/src/control-types.ts:140` (`subagent/attachment-invalid`) | **motivating bug fixed**; the retained `attachment-error` arm is a harmless legacy accept ✓ |

## 3. Findings

| ID | Severity | Event / contract | Evidence (dsp → host) | Impact | Fix |
|---|---|---|---|---|---|
| **A-01** | **P0** | `Session.append` write-envelope contract for the dsp-private `serenity/bound` session event (`SessionEvent.ignorable`) | dsp `src/session-bound.ts:106-127` appends `serenity/bound` at `:114` through an untyped `append` cast (`:113`); declaration `:27-46`. Host: `core/session/src/known-event-types.ts:22-74` has no `serenity/*` member; `session/session-persistence/src/coordinator.ts:1248-1252` refuses any unknown type without the envelope marker, called on **every** stored-load path `:1027, :1057, :1074, :1509`; `core/session/src/index.ts:668-697` builds the envelope with no way to set `ignorable`; `core/session/src/types.ts:442-452` defines the marker. dsp's own design requires it: `docs/session-binding-hardening-research.md:39,53` ("`ignorable: true`") | Every dsh session that ran `session use` / `create` / `logbook rebuild` gets a durable `serenity/bound` event that the harness **refuses to reinterpret on reload** (`SessionFormatUnsupportedError`, "unknown to this harness and not marked ignorable"). The persistence mechanism designed to make SESSION binding robust is the mechanism that can make the session unloadable — ACC loses the very trajectory anchor it wrote. | Mark the event ignorable at write time. `Session.append` cannot set the envelope marker, so this needs a host-supported write path (or a `ctx.effect`-owned helper) — do **not** paper over it with a cast. Interim: stop appending `serenity/bound` until the write path is verified, and add a load-path regression test (write → flush → reload) asserting the session still loads. **Unverified at runtime** — see §5. |
| **A-02** | **P1** | `agent/pre-step` → `PreStepDecision` | dsp `src/seams/context.ts:250`: `return { kind: 'enter', messages: [accMessage(…), ...messages, ...downstream.messages] }` where `messages` is the payload's claimed list. Host: the innermost `next()` already returns `[...claimed, context]` (`core/agent-loop/src/agent.ts:245-248`), the doc states "Calling `next()` preserves the current messages" (`core/agent/src/runtime-types.ts:228-231`), and the host's own precedent returns `{kind:'enter', messages: [extra, ...claimed]}` **without** re-adding the payload (`core/agent-loop/tests/interception.spec.ts:267-273, 487-493`). `decision.messages` are then appended as `user/message` events (`agent.ts:291-293`) | Whenever this branch fires (i.e. whenever `injected` does not already contain the session key — session-start seeding skipped or threw; `context.ts:95,211,248`), the claimed user message(s) are **duplicated** in the durable log and in the model request. No dsp test covers `agent/pre-step` at all (`grep pre-step tests/` → 0 matches), so the defect is invisible today. | `messages: [accMessage(…), ...downstream.messages]` — drop the `...messages` spread. Add a unit test asserting the returned `messages` length equals `downstream.messages.length + 1`. |
| **A-03** | **P1** | `Agent.interrupt` (not an event; same class) | dsp `src/acp-core.ts:180-192`: `(agent as unknown as { interrupt?: () => void }).interrupt?.()`, then unconditionally `return { cancelled: true }`. Host: `Agent` exposes only `cancel(cause: AgentCancelCause, options?)` (`core/agent/src/runtime-types.ts:91`), `whenIdle`, `runMaintenance`, `send`, `followup`, `steer`, `inject`; base interface `core/agent/src/types.ts:12-15`; `interrupt` exists only on the **subagent service** with a different signature (`subagent/subagent/src/index.ts:293`) | ACP `session/cancel` is a permanent silent no-op that reports success. **Already reported: slice-D D-01** (kept here because it is the same assertion-hidden class this slice audits). | `agent.cancel({ kind: 'user' })` (`AgentCancelCause` at `core/session/src/types.ts:181-185`). Delete the fake's `interrupt` member in `tests/acp-core.test.ts:80,93` so the test can no longer certify the no-op. |
| **A-04** | **P1** | Missing `agent/disposed` / `session/disposed` coverage | dsp: **zero** subscriptions to either name (`grep -n 'agent/disposed\|session/disposed' src/` → no matches). Per-session state lives in process-lifetime containers: `seams/context.ts:95` (`injected` Set), `seams/keeper.ts:133,142`, `seams/guards.ts:224` (`safeModeRestrictions`, holding `restrict()` disposers), `seams/bootstrap.ts:115,247,249`, `seams/system-prompt.ts:597`, `output-guard.ts:192`, `session-ops.ts:342`, `skiff-registry.ts:20`. Host: `agent/disposed` `runtime-types.ts:175`, `session/disposed` `core/session/src/index.ts:62` | (a) Unbounded growth of ~10 maps keyed by session id over a long-lived `dsh web` process; (b) `safeModeRestrictions` retains disposers for agents whose fiber already unwound, so `getRestrictDiagnostics().activeKeys` (`guards.ts:243-245`) reports phantom agents; (c) **`waitIdle` never settles** if the agent is disposed before reaching `idle` (`skiff-core.ts:362-377`, `tools/handyman.ts:58-71`) — the ACP/weixin/handyman call hangs forever with no timeout. | Subscribe `agent/disposed` → delete every per-agent key and dispose the cached `restrict()`; subscribe `session/disposed` → drop bridge/tracker state. Make `waitIdle` settle on disposal too (race `agent/status` with `agent/disposed`). |
| **A-05** | **P1** | Host shutdown/dispose: no event exists; dsp registers no teardown | dsp: `grep -n 'ctx\.effect' src/` → **no host-side match** (only 4 client-side `scope.effect` in `src/client/index.ts`). Long-lived resources: gateway HTTP/WS server (`gateway.ts:535-547`, `dispose` exists but is only called from `sync()`), skiff debug server (`skiff-debug.ts:458-461`), ACP HTTP server (`acp-http.ts:93-96`), autopilot timer (`autopilot-trajectory.ts:375` `unref()` but never `clearInterval`), weixin polling loops (`weixin-bridge.ts:45`). Host: cordis has no app-shutdown event (`vendor/cordis/src/events.ts:329-351` = `internal/*` only) | On plugin unload/reload (HMR, profile change, `dsh plugin` update) the old listeners/servers/timers survive: ports stay bound (next load hits `EADDRINUSE` in `listenWithRetry`), and a reloaded plugin doubles timers/pollers. Reproduces the "restart fixes it" class of failure. | Wrap every long-lived resource in `ctx.effect(() => () => teardown)` so cordis owns disposal; keep the manual `stop*` functions for the settings-toggle path. |
| **A-06** | P2 | `ctx.on` options cast | dsp `seams/bootstrap.ts:402`: `}, { prepend: true } as never)` | `{prepend:true}` is a valid `EventOptions` (`vendor/cordis/src/events.ts:112-117`); the `as never` suppresses the option type entirely, so a future option rename degrades to a silent ordering change (bootstrap's context-strip must run after context.ts's inject). | Drop the cast: `}, { prepend: true })`. |
| **A-07** | P2 | Three `sessionEvents` implementations | `session-ops.ts:52-64` (canonical), `skiff-core.ts:385-389`, `tools/handyman.ts:77-78` — the last two self-document as copies | The rc.1 compatibility shim that fixes the motivating bug exists three times; the bare-`.events` regression can return in any copy. **Cross-ref slice-D S-04 / slice-F §4-3.** | Import the canonical helper in both files; delete the copies. |
| **A-08** | P2 | Redundant casts that hide signature drift | `seams/keeper.ts:110` `(ctx as unknown as {get?}).get?.('sessionProjections')` although `sessionProjections` is a declared injection (`index.ts:52`; host `session/session-projection/src/index.ts:208`); `gateway.ts:607` same for `webServer` (also injected); `tools/handyman.ts:67` / `skiff-core.ts:373` type `status: string` instead of the host `AgentStatus` union (`runtime-types.ts:53`) | The cast works today (`snapshot()` returns `{asOfSeq, values}` with a wired `contextPressure` key — `session-projection/src/index.ts:338-352`, `llm/token-meter/src/usage-projection.ts:181-226`), but a rename would degrade to a silent `undefined` instead of a typecheck error — the exact mechanism that hid the motivating bug. | Use the typed `ctx.sessionProjections` / `ctx.webServer`; type the status handler as `AgentStatus`. |

## 4. Uncovered host extension points

Full rc.1 surface = `api-catalog.ts:2876-3397`. Events dsp subscribes to: 10 host names
(+4 dsp-private `serenity/*`). Everything below is host surface dsp does not touch.

| Host point (mode) | Consequence for ACC | Effort |
|---|---|---|
| `agent/disposed` (emit) | Per-agent ACC state never reclaimed; `waitIdle` hangs; restrict diagnostics report dead agents (A-04) | S |
| `session/disposed` (emit) | Tracker/bridge/binding state outlives the session; `weixin-bridge`/`autopilot` keep scanning stale roots | S |
| `agent/error` (emit) | Failed turns/steps leave **no ACC record**: keeper, rebuild-pressure and trajectory logic cannot distinguish "stuck" from "idle"; the ACC discipline "no errors, only gaps" has no gap record | S |
| `agent/request-error` (waterfall) | ACC cannot own model-request recovery (fallback model, retry guidance); retries stay invisible to the trajectory | M |
| `session/flush` (parallel) | The `serenity/bound` anchor has no durability checkpoint; on a crash the binding event may not be on disk while the session is — the recovery chain silently degrades to text scan (`context.ts:178-197`) | S |
| `tools/change` (emit) | Safe-mode tool hiding is re-synced only on `agent/pre-step` (`guards.ts:239-247`); a tool registered/restricted later leaves the model-visible catalog inconsistent until the next step | S |
| `tools/execute` (waterfall) / `tools/result` (emit) | No around-dispatch observation: no ACC-side timeout/metrics, and the "final frozen outcome" (vs the post-execute projection) is unobservable, so audit of what the model actually received is indirect | M |
| `agent/inbox/claimed` / `agent/inbox/discarded` (emit) | Canceled/discarded user work is unrecorded — a canceled task leaves no trace in SESSION.md reasoning | S |
| `subagent/start` / `subagent/end` (emit) | Crew lifecycle (handyman workers, delegated children) is unobservable; the "leave a handover" duty cannot be asserted from the container's own events | M |
| `approval/request` (waterfall) | dsp's deny/ask decisions (`PreToolDecision.ask`) interact with host approval policy with no ACC-side observation; safe-mode semantics can drift silently | S |
| `settings/updated` / `settings/document-updated` (emit) | dsp relies on its own `onChange` hook (`settings-section.ts:152-162`), so host-level or other-plugin settings changes that affect ACC behavior are invisible | S |
| `system-prompt/change` / `skills/change` (emit) | Prompt/skill registry invalidations are unobserved; `sectionedAgents` (`system-prompt.ts:597`) and injected identity text can go stale after a provider swap | S |
| `llm/stream` (waterfall) | No token-level observation; the rebuild trigger stays a polling read of `contextPressure` on each tool call (`keeper.ts:199-216`), so a long tool-free stretch never triggers it | M |
| `fs/write-intent` / `fs/edit-intent` / `fs/observed` (waterfall/emit) | The P3 path guard is **tool-layer only** (`tools/pre-execute` + `tools.guard`): a host-side or other-plugin write path bypasses the CCC boundary entirely — the hull is only as tight as the tool list | M |
| `goal/changed` (emit) | Goal mutations (autopilot trajectory / goal rounds) unobservable; ACC cannot reconcile a goal with its SESSION anchor | S |
| `session-telemetry/record` (waterfall) | ACC-injected text (identity, SESSION context, credentials-adjacent paths) cannot be redacted from exported telemetry — the seam ships no rules of its own | M |
| `user-questions/request` (waterfall) | No ACC-side policy over structured user questions (e.g. refusing questions from external faces) | S |
| Host shutdown/dispose (no event; cordis `internal/status` only) | No teardown of long-lived servers/timers → port conflicts and duplicate pollers after reload (A-05); the correct seam is `ctx.effect`, not an event | M |

## 5. Method & limits

**Method.** Static read-only audit (bash disabled in this session; no build, no test run, no typecheck).
For every dsp `ctx.on(...)` site the event name was matched against the host's generated `EVENT_API`
catalog (`api-catalog.ts:2876-3397`) **and** its `interface Events` declaration site; payload/arity were
read from the declaration and, for waterfall/serial events, from the dispatch site in `agent-loop`/`tools`
to confirm what `next()` actually resolves to. `SessionEventMap` members were verified directly against
`known-event-types.ts` + `compaction/src/types.ts` (not via the catalog, which covers cordis events only).
The "gap lens" enumerates the complete catalog surface minus dsp's 10 host subscriptions.

**Could not verify statically (marked, not speculated):**
- **A-01 runtime consequence.** Whether the production profile actually mounts
  `session-persistence` / `session-persistence-jsonl` (so `assertEventsSupported` runs on load) is not
  provable from this checkout — the running config lives under `~/.dsh`, outside the CCC root
  (path isolation), and no session log is readable here. The refusal *code path* is proven; the
  production *reachability* is inferred. This is the single highest-value item to confirm on a live host
  (write a `serenity/bound`, restart, reload the session).
- **Host version identity.** The checkout's root `package.json` reports `0.1.2-rc.1`; whether the
  npm-installed host on the running machine is byte-identical was not verified (out of scope; see slice-G).
- **Scope mounting.** Verified that an *untagged* listener receives all agent-scoped events
  (`scope/src/index.ts:170-185`). dsp is assumed to be loaded at the root composition (its
  `config.yaml` insert); if it were ever loaded inside a per-agent scope, **every** agent-scoped
  subscription would silently stop matching other agents. Not verifiable from inside the CCC.
- **Client side.** No host event subscriptions exist in `src/client/` (`grep` → 0), so client-side
  event contracts were not audited; client slots/props are out of this slice.
- **HMR / reload behaviour (A-05).** Reasoned from cordis disposal semantics
  (`vendor/cordis/src/events.ts:125-129`, `fiber.ts`); not observed live.
- **Overlap with other slices.** A-03 is slice-D D-01; A-07 is slice-D S-04 / slice-F §4-3; slice-F F-14
  covers the general hard-coded-event-name entropy. A-01 and A-02 are unique to this slice.
