# Slice E — Test Fidelity & Host-Contract Coverage

Scope: `AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/` (dsp v1.30.5, 54 test files / 913 tests),
verified against host `AI_LAB/dsh-harness-public` @ 0.1.2-rc.1. **Read-only slice**: no source modified,
no test edited, no fix applied. Only this report was written.

Motivating failure mode (two shipped bugs, both green): the host replaced `Session.events` with
`snapshotEvents()` and renamed the image-rejection code `attachment-error` →
`session/attachment-invalid`. dsp read `.events` through `as unknown as` and matched the old code
literal. Both stayed green because **the tests encode dsp's assumptions about the host, not the host's
contract**. This slice measures how much of the suite is assumption, and proposes a guard.

Related: `slice-D-assertion-audit.md` audits the *source-side* assertion sites; this slice audits the
*test-side* doubles that let those assertions survive.

---

## 1. Verdict summary

| Metric | Count |
|---|---|
| Test files | 54 (913 tests) |
| Test files containing hand-built host-object doubles | **29 / 54** |
| Distinct double classes audited (this slice's IDs) | **14** |
| Host-object double *sites* audited | **62** |
| Host-package module mocks (`vi.mock('@deepseek-ai/*')`) | **51 calls in 21 files** |
| `as never` casts in tests | **239** |
| `as any` casts in tests | **4** |
| `as unknown as` casts in tests | **7** |
| Test files importing a **real** host type or value | **1** (`tests/handyman-preset.test.ts:2`, type-only `Context` from `cordis`) — **0** import any `@deepseek-ai/*` |
| Doubles exposing members the host **no longer has** (stale) | **26 sites across 8 classes** |
| Doubles **omitting** members the host has (incomplete) | **45 sites across 9 classes** |
| Mapped host surfaces | **35** (11 events + 16 services + 3 append types + 5 client) |
| Mapped host surfaces with a fully realistic-shape test | **0 / 35** |
| Mapped host surfaces with partial shape coverage | **5 / 35** |
| Mapped host surfaces untested, or covered only via a stale/incomplete double | **30 / 35** |
| P0 findings (a real host-contract bug would ship undetected) | **8** (6 double-fidelity + 2 assertion-quality) |
| P1 findings | **9** (5 + 4) |
| P2 findings | **5** (3 + 2) |

**Headline**

1. **The suite has zero compile-time coupling to the host.** `src/` imports 30+ host types via
   `tsconfig.json` `paths` → the installed `@deepseek-ai/dsh` (`tsconfig.json:17-46`), so `tsc` *does*
   check dsp against the real host. `tests/` imports nothing from `@deepseek-ai/*` — every host package
   is replaced by `vi.mock` (21 files) and every host object by a hand-written literal. The compiler's
   protection therefore stops exactly where the tests begin.
2. **The motivating bug is still certified by the suite.** `Session.events` — the member rc.1 removed —
   is still exposed by 11 test doubles and still has a production fallback branch in 4 dsp modules
   (`session-ops.ts:63`, `skiff-core.ts:387`, `tools/handyman.ts:78`, and through them
   `seams/bootstrap.ts`, `seams/context.ts`, `rebuild.ts`, `autopilot-trajectory.ts`). Those branches are
   unreachable against rc.1; their coverage is fake.
3. **A second, currently-live host-contract defect is invisible to the suite** (E-06): dsp appends
   `serenity/bound` as a *required* session event, which `session-persistence` refuses to read in a build
   without dsp. The `append` double cannot express the envelope contract that makes this wrong.
4. **The doubles are not merely incomplete — they are the de-facto host spec.** Where a double and the
   host disagree, the double wins, because it is the only thing that runs. `slice-D` finding D-01
   (`agent.interrupt?.()`) is the same defect seen from the other side: a test double *supplied* the
   nonexistent member.

---

## 2. Double-fidelity findings

Severity: **P0** = a real host-contract bug would ship undetected; **P1** = meaningful blind spot;
**P2** = hygiene.

| ID | Sev | test file:line | Host type (declaration site) | Problem | Consequence |
|---|---|---|---|---|---|
| **E-01** | **P0** | `tests/register.test.ts:60-66` | cordis `Context` | `mockCtx()` = `{ tools: { register, guard }, on } as any`. The `as any` erases the type entirely; the double omits 8 of the 10 services dsp declares in `inject` (`src/index.ts:52`: `webServer`, `sessions`, `shellEnv`, `skills`, `agentLoop`, `agents`, `systemPrompt`, `sessionProjections`, `settings`) plus `emit`/`inject`/`effect`. | Renaming any of the 3 doubled members, or adding a required injected service, keeps all 913 tests green. This is the plugin's entire registration contract, tested against a 3-member object. |
| **E-02** | **P0** | `tests/bootstrap.test.ts:17-19`; `output-guard.test.ts:155-161`; `skiff-core.test.ts:45-47`; `skiff-debug.test.ts:255-258`; `weixin.test.ts:433-437`; `acp-core.test.ts:80,162`; `session-ops.test.ts:278,291`; `session-bound.test.ts:71-78`; `autopilot-trajectory.test.ts:52-57,650` | `Session` — `packages/core/session/src/index.ts:425` (`snapshotEvents()` at `:600`; **no `events` property**) | 11 doubles expose `.events`, a member rc.1 removed. | The exact motivating bug is still certified. dsp keeps a `.events` fallback whose only justification is these doubles; if the host re-adds/removes either shape, the suite cannot tell. |
| **E-03** | **P0** | `tests/autopilot-trajectory.test.ts:48-58` | dsp's own `src/session-ops.ts` | The module is `vi.mock`ed and `sessionEvents` is re-implemented inline in the test (`:52-57`). | The helper under test is replaced by the test's own copy — a tautology. A bug in `sessionEvents` (including the `.events` fallback) cannot fail this file. This re-implementation is the only remaining place `.events` still "works". |
| **E-04** | **P0** | `tests/autopilot-trajectory.test.ts:534-549,647-654,702-733,744-760,772-784,795-805,822-839,864-867,987-990`; `skiff-debug.test.ts:110,148` | `SessionStore.list(): Session[]` — `packages/core/session/src/index.ts:1127` | Doubles return plain records `{ id, header, events }`, not `Session[]`. No test ever constructs a real `Session`. | Every consumer of `ctx.sessions.list()` (`src/index.ts:223`, `src/api.ts:168`, `src/skiff-debug.ts:110`, `src/weixin-bridge.ts:398`, `src/autopilot-trajectory.ts:417,491,525,626`) is untested against the real return type — including `header.cwd` presence, which the whole CCC-resolution path depends on. |
| **E-05** | **P0** | `settings-section.test.ts:28-31`; `register.test.ts:48-51`; `keeper.test.ts:23-26`; `rebuild.test.ts:24-27`; `gate.test.ts:23-25`; `gateway.test.ts:27-29`; `autopilot-trajectory.test.ts:44-47` | `SettingsProvider.installSection` — `packages/settings/settings/src/index.ts:472` | 7 files mock `@deepseek-ai/dsh-settings` with `{ installSettingsSection, settingsNamespace }` — **exports rc.1 does not have**. | Stale mock exports hide the real rc.1 migration. `registerSettingsSection` is called by **no test**, so `settingsAny.installSection.call(settingsAny, ctx, ns, schema, entry, hooks)` (`src/settings-section.ts:171`) — the `this`-binding fix the code comments call "第四次同病根治" — is never executed. |
| **E-06** | **P0** | `tests/session-bound.test.ts:12-23` | `Session.append` — `packages/core/session/src/index.ts:668`; event envelope `packages/core/session/src/types.ts:434-452` | The double accepts `(type: string, data: unknown)` and returns `{type, seq, time, data}`. The real `append` is generic over `SessionEventType` and its only third argument (`SurfaceIntent`, `types.ts:410`) carries `surfaceOp`/`sourceEventSeqs` — **there is no way to set `ignorable`**. | dsp's `appendBound` (`src/session-bound.ts:114`, 6 production call sites) writes `serenity/bound`, which is absent from `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts:22-74`). `session-persistence`'s `assertEventsSupported` (`packages/session/session-persistence/src/coordinator.ts:1248-1252`) then **refuses to load such a log** in any build without dsp loaded. No test references `ignorable` or `KNOWN_SESSION_EVENT_TYPES`. |
| **E-07** | P1 | `skiff-core.test.ts:116-137,164-175,188-197,210-215,227-238,546-553`; `weixin.test.ts:455-470`; `acp-core.test.ts:79-95`; `skiff-debug.test.ts:252-259` | `AgentHandle` — `packages/core/agent/src/index.ts:165` (`{ agent, dispose() }`) | 8 doubles return `{ agent }` with no `dispose()`. | The owner-disposal contract is never exercised; leaked agents/sessions (one per skiff/weixin session) are invisible to the suite. |
| **E-08** | P1 | `bootstrap.test.ts:13-19`; `skiff-core.test.ts:45`; `output-guard.test.ts:155`; `compact.test.ts:47`; `guards.test.ts:211`; `rebuild.test.ts:81` | `Agent` — `packages/core/agent/src/runtime-types.ts:71-149` (`session`, `inbox`, `status`, `ctx`, `cancel`, `whenIdle`, `send`, `followup`, `steer`, `inject`) | Doubles keep only `session` + one verb (usually `steer`/`followup`/`inject`); `ctx`, `inbox`, `status`, `cancel`, `whenIdle`, `send` absent. `guards.test.ts:223` adds `as any`. | Any dsp path that starts using `agent.inbox` / `agent.cancel` / `agent.whenIdle` has no double that can fail, and no test that would notice. |
| **E-09** | P1 | `system-prompt.test.ts:141-147,171-177,188-194` | `SystemPrompt.section` — `packages/core/system-prompt/src/index.ts:432` | The double returns `undefined` instead of the disposer, cannot throw on a duplicate name, and ignores the `ctx.effect` registration semantics. | Duplicate-section throw and disposal-on-unload are untested; `registerEntrySkillSectionGlobal` is called 3× but only its `text` callback is asserted. |
| **E-10** | P1 | `opencode-skills.test.ts:72-81` | `SkillRegistry.registerProvider` — `packages/skill/skill/src/index.ts:386` | The double ignores the `SkillProviderControl` argument and never disposes. | The one host surface whose provider shape matches rc.1 exactly (`SkillProvider`, `skill/src/index.ts:249-269`) is still not tested for disposal/`invalidate` semantics. |
| **E-11** | P1 | `keeper.test.ts:113-132`; `rebuild.test.ts:434-452`; `session-title.test.ts:170,241` | `sessionProjections.snapshot` (`api-catalog.ts:1604`), `tokenMeter.estimateMessage` (`:2464`), `sessionTitle.rename` (`:1875`) | Optional-service doubles are 1-method literals returning hand-made payloads (`{ values: { contextPressure: {...} } }`). | A change in the projection cut's return shape, or in `estimateMessage`'s signature, passes silently; the rebuild pressure trigger is never tested against a real projection. |
| **E-12** | P2 | `image-fallback.test.ts:91,99,100,104,113,120,121,126` | client `Context` (`ctx.get('conversation')`, `ctx.sessions.binding`) | 1-member literals; `draftImages` double returns `[{ file }]` matching `ComposerAttachment` (`ui-conversation/src/client/contract/slots.ts:26`) but nothing checks it. | Client host-prop drift undetected (pairs with slice-D D-11…D-14). |
| **E-13** | P2 | `image-fallback.test.ts:44-57` | global `fetch` / `btoa` | `vi.stubGlobal` fakes return hand-made `{ ok, json }`. | The host's error projection (`PromptError.error.details.reason`, `api/session-controller/src/client/contract/snapshot.ts:59`) is only ever compared against dsp's own literal (see A-1). |
| **E-14** | P2 | `autopilot-trajectory.test.ts:974,1106` | `setInterval`/`clearInterval` | Timer doubles. | Acceptable; noted for completeness. |

**Cast-hidden mismatch (the mechanism, not a separate class).** 239 `as never` + 7 `as unknown as` +
4 `as any` casts in tests mean no double is ever checked against the signature it stands in for. The
compiler is told "trust me" 250 times per suite run.

---

## 3. Contract coverage matrix

`Realistic?` = the test exercises the surface through a double whose members and return shapes match the
rc.1 declaration. `Via stale double` = the test passes *because* the double has a member the host lacks.

### 3.A Host events subscribed by dsp

| Host surface (declaration) | dsp site | Test file(s) | Realistic? | Gap |
|---|---|---|---|---|
| `agent/session-start` (`agent/src/runtime-types.ts:224`) | `seams/context.ts:219`, `gateway.ts:664` | none | **No** | `registerContext` is called by **no test**. Only `register.test.ts` asserts the string is in the `on` call list. |
| `agent/pre-step` (`:238`) | `seams/context.ts:230`, `seams/bootstrap.ts:382` | none | **No** | Both listeners untested; bootstrap's `{ prepend: true } as never` third argument (`bootstrap.ts:402`) is unchecked against the host's listener-options type. |
| `agent/turn-stopping` (`:285`) | `rebuild.ts:395`, `output-guard-seam.ts:56` | `rebuild.test.ts:370-411`, `output-guard.test.ts:176-248` | **No** | Payload double is `{ agent, turn }`; the host also passes `signal: AbortSignal`, and `output-guard`'s agent double exposes `.events` (E-02). |
| `agent/status` (`:185`) | `tools/handyman.ts:67`, `skiff-core.ts:373` | `skiff-core.test.ts:67-74` (`fakeCtx` fires `idle` synchronously) | **Partial** | The double fires the callback *during registration*, which the real emit mode does not do; `handyman.ts:67` is untested. |
| `agent/inbox/inserted` (`:193`) | `seams/bootstrap.ts:277` | none | **No** | Untested; the double in no file reaches it. |
| `session/event` (`api-catalog.ts:3198`) | `seams/compact.ts:50`, `seams/bootstrap.ts:261` | `compact.test.ts:33-52`; `register.test.ts:115` (name only) | **No** | `compact` double passes `{ id }` as the Session (no `header`, no `snapshotEvents`); bootstrap's listener untested. |
| `session/created` (`:3182`) | `weixin-bridge.ts:412`, `autopilot-trajectory.ts:386` | `autopilot-trajectory.test.ts:1048-1078` | **Partial** | Emitted by a hand-built `emit()`; the host emits with a `Session` argument that the test never supplies. |
| `tools/pre-execute` (`:3310`) | `seams/guards.ts:349` | `register.test.ts:99-116` (name only) | **No** | `registerGuards` is called by **no test**. `decideGuard` is well tested as a pure function, but the waterfall wiring + `ctx.tools.guard` terminal registration are not. |
| `tools/post-execute` (`:3302`) | `seams/keeper.ts:170` | `gate.test.ts:39-44,95-104`; `keeper.test.ts:149-154` | **No** | `exec` double is `{ name, agent: { session: { id, header } } }`; the host `ToolExecution` carries `arguments`, `signal`, `callId`, `agent` — `arguments` is only present when a test needs it. |
| `system-prompt/assemble` (`:3270`) | `seams/bootstrap.ts:332` | none | **No** | Untested; the `PromptAssembly` double never exists, so `assembled.tools` narrowing (`bootstrap.ts:344-374`) is unverified. |
| `serenity/settings-changed` (dsp-private) | `index.ts:206,281`, `gateway.ts:687`, `autopilot-trajectory.ts:393` | `settings-section.test.ts` (via `emit` spy, mocked) | **No** | Private event; no host contract. Low risk. |

### 3.B Host services used

| Host surface (declaration) | dsp site | Test file(s) | Realistic? | Gap |
|---|---|---|---|---|
| `ctx.tools` — `register`/`guard`/`restrict`/`get`/`schemas` (`api-catalog.ts:2514`) | `index.ts:109-120`, `seams/guards.ts:356`, `seams/system-prompt.ts:523` | `register.test.ts` (register/guard), `guards.test.ts:216` (restrict), `system-prompt.test.ts:232` (get) | **No** | Every double supplies only the one method under test; `defineTool` is mocked to the identity function (`register.test.ts:3-5`), so `defineTool`'s own validation (schema → JSON Schema, `packages/core/tools/src/schema.ts:545`) never runs. |
| `ctx.sessions` — `list`/`get`/`create` (`:1774`) | `index.ts:223`, `api.ts:168`, `rebuild.ts`, `skiff-debug.ts:110`, `weixin-bridge.ts:398`, `autopilot-trajectory.ts` | `rebuild.test.ts:174-252,383`, `autopilot-trajectory.test.ts` (9 sites), `skiff-debug.test.ts:148` | **No** | E-04: `list()` returns records, not `Session[]`; `get()` returns a hand-made session. |
| `ctx.agents` — `create`/`resume`/`get` (`:253`) | `skiff-core.ts:282,304,335`, `weixin.test.ts`-covered bridge, `tools/handyman.ts` | `skiff-core.test.ts` (8 doubles), `weixin.test.ts:455-470`, `acp-core.test.ts:79-95`, `skiff-debug.test.ts:252` | **No** | E-07: handles lack `dispose()`. `resume` is doubled by a mode switch (`skiff-core.test.ts:226-244`), never by the host's `ResumeAgentOptions` (`agent/src/index.ts:132-144`). |
| `ctx.shellEnv` — `register` (`:2049`) | `seams/env.ts:46` | none | **No** | `registerEnv` is called by **no test**; the `BashEnvContributor` shape (`{name, variables, resolve}`) is unverified. |
| `ctx.skills` — `registerProvider` (`:2074`) | `seams/opencode-skills.ts:64` | `opencode-skills.test.ts:95-155` | **Partial** | Provider `list`/`get` shapes match rc.1 exactly (good); `SkillProviderControl` and disposal untested (E-10). |
| `ctx.systemPrompt` — `section` (`core/system-prompt/src/index.ts:432`) | `seams/system-prompt.ts`, `skiff-core.ts:209` | `system-prompt.test.ts:138-195` | **No** | E-09. |
| `ctx.sessionProjections` — `snapshot` (`api-catalog.ts:1604`) | `seams/keeper.ts:110` | `keeper.test.ts:112-133` | **No** | E-11. Also read via `ctx.get?.('sessionProjections')`, so a rename silently disables the rebuild pressure trigger. |
| `ctx.settings` — `installSection` (`packages/settings/settings/src/index.ts:472`) | `settings-section.ts:171` | none | **No** | E-05: `registerSettingsSection` has no test; the mock exports rc.1-removed helpers. |
| `ctx.webServer` — `port` (`:2714`) | `index.ts:248` | none | **No** | Read through `as unknown as`; untested. |
| `ctx.sessionTitle` — `rename` (`:1875`) | `tools/session.ts:184`, `rebuild.ts:372` | `session-title.test.ts:170,241` | **No** | E-11. |
| `ctx.tokenMeter` — `estimateMessage` (`:2464`) | `rebuild.ts:414` | `rebuild.test.ts:434-452` | **No** | E-11. |
| `ctx.workspaceRegistry` — `list` (`:2825`) | `api.ts:335`, `skiff-debug.ts:89` | `skiff-debug.test.ts:98,123` | **No** | Double returns `{ list: () => [] }`; `path`/`title` fields never checked. |
| `ctx.sessionPersistence` — `list` (`:1462`) | `skiff-debug.ts:99` | `skiff-debug.test.ts:147` | **No** | Same. |
| `ctx.connection` (gateway) | `gateway.ts:566` | none | **No** | Untested optional service. |
| `ctx.agentPresets` — `mount` (skiff preset) | `skiff-core.ts:199` | `skiff-core.test.ts:122` | **No** | Double is `{ mount: async () => {...} }`; the real `mount(agentCtx, id)` contract (`api-catalog.ts:145`) unverified. |
| client `ctx.slots` / `conversation` / `sessions` / `settingsScope` (`src/client/index.ts:34`) | client half | `image-fallback.test.ts`, `file-fallback.test.ts` | **No** | E-12; no client-slot test renders `conversation.input.dock`. |

### 3.C Session append event types written by dsp

| Event type | dsp site | Test file(s) | Realistic? | Gap |
|---|---|---|---|---|
| `compaction/prune` (known to host) | `rebuild.ts:340` | `rebuild.test.ts:330-365` (via `fakeSession` recording appends) | **Partial** | Payload is passed `as never`; the double records it without validating against `packages/compaction/compaction/src/types.ts:82-89`. The shape happens to match, but nothing enforces it. |
| `user/message` (surface replace) | `rebuild.ts:347` | same | **Partial** | `surfaceOp`/`sourceEventSeqs` passed `as never`; the surface-fold contract (`core/session/src/surface.ts:330-357`) is never exercised. |
| `serenity/bound` (**not** known to host) | `session-bound.ts:114` (6 call sites) | `session-bound.test.ts:26-120` | **No** | **E-06.** Declared via `declare module` (`session-bound.ts:27-48`) so dsp's own `tsc` accepts it, but absent from `KNOWN_SESSION_EVENT_TYPES`; no test references the envelope or the known-type set. |

### 3.D Client slots and error codes

| Surface | dsp site | Test file(s) | Realistic? | Gap |
|---|---|---|---|---|
| `conversation.input.dock` (×2 registrations) | `client/index.ts:61,81` | none | **No** | No test asserts the slot name exists in the host's `SlotMap` (`ui-conversation/src/client/contract/slots.ts:127`) or renders the dock. |
| `session/attachment-invalid` | `client/image-fallback-api.ts:32` | `image-fallback.test.ts:9-10` | **No** | **A-1**: asserted against dsp's own literal. |
| `subagent/attachment-invalid` | same | `image-fallback.test.ts:13-14` | **No** | same |
| `attachment-error` (pre-rc.1) | same | `image-fallback.test.ts:5-6` | **No** | same — a code the host no longer emits. |
| `MODEL_DOES_NOT_SUPPORT_IMAGES` (reason) | same | `image-fallback.test.ts:5-25` | **No** | same |

**Counts.** **35 surfaces mapped** (11 events + 16 services + 3 append types + 5 client surfaces).

| Coverage | Count | Which |
|---|---|---|
| Realistic (double matches the rc.1 declaration in members *and* return shape) | **0** | — (the opencode-skills provider is the only exact match, but its control/disposal contract is still undoubled) |
| Partial (shape matches for the exercised path; other required members absent, or the call is `as never`) | **5** | `agent/status`, `session/created`, `ctx.skills.registerProvider`, `compaction/prune`, `user/message` (surface replace) |
| Unrealistic / untested / stale-double-only | **30** | everything else |

No host surface has a fully realistic double. That is the slice's core result: the suite's fidelity
ceiling is *partial*.

---

## 4. Assertion-quality issues

| ID | Sev | Site | Problem |
|---|---|---|---|
| **A-1** | **P0** | `image-fallback.test.ts:4-27` | All five cases assert dsp's own copies of host string literals (`'session/attachment-invalid'`, `'subagent/attachment-invalid'`, `'attachment-error'`, `'MODEL_DOES_NOT_SUPPORT_IMAGES'`). The host renamed the code once already; renaming it again keeps this file green. **The test is the assumption.** Fix: assert against the host's declared code map — `RemoteErrorDetailsMap['session/attachment-invalid']` (`api/session-controller/src/types.ts:194`) and `RemoteErrorCode` — or against a probe result (§5). |
| **A-2** | **P0** | `register.test.ts:99-116` | Asserts subscription *names* (`expect(events).toContain('tools/pre-execute')`) with `on = vi.fn()`. Renaming a host event string keeps it green; the assertion is on dsp's own literal list, not on the host's `Events` interface. No test asserts that the event names dsp subscribes to exist in `@deepseek-ai/cordis`'s merged `Events`. |
| **A-3** | P1 | 239 sites | `as never` in tests makes every double acceptable to any signature. This is the mechanism that let `.events`, the stale settings exports and the missing `dispose()` survive: each cast converts a type error into a silent pass. |
| **A-4** | P1 | `bootstrap.test.ts:168-191` vs `session-bound.test.ts:71-78` | The suite simultaneously asserts that `snapshotEvents()` works *and* that `.events` works. A suite that accepts both host shapes cannot detect the removal of either — the "rc.1 regression" test (`bootstrap.test.ts:174-179`) sits beside a legacy-shape test that still passes. |
| **A-5** | P1 | `session-ops.test.ts:275-305` | The describe title claims "v1.28.1 适配 0.1.2-rc.1" yet `:282-296` asserts the `.events` fallback as a supported contract ("测试替身/旧运行时形态"). The fallback is dead code against rc.1; the test certifies it as behaviour. |
| **A-6** | P1 | `rebuild.test.ts:318-365` | `performRebuild` appends `compaction/prune` and the replace `user/message` with `as never` on both data and options (`rebuild.ts:340-354`). No test asserts the appended payload against the host's `compaction/prune` type, so the shadow-price protocol (a documented rc.1 requirement) is asserted only by dsp's own comments. |
| **A-7** | P2 | `register.test.ts:82-97` | Asserts `register` was called 10× and that the 10 names are present — i.e. counts registrations, not that each definition satisfies `ToolDefinition`. With `defineTool` mocked to identity, `defineTool`'s validation never runs. |
| **A-8** | P2 | `settings-section.test.ts:35-85` | Asserts `entryDefaults`/`SERENITY_SETTINGS_NS` only. These are pure dsp values, so the tests are legitimate — but they give the *appearance* of covering the settings seam while `registerSettingsSection` is untested (E-05). |

**Not a defect (recorded to distinguish).** Assertions on dsp-owned prompt text
(`system-prompt.test.ts`, `keeper.test.ts:62-110`) are correct: dsp owns that text. The distinction this
slice draws is *host* strings asserted as dsp literals (A-1, A-2) versus dsp's own strings (fine).

---

## 5. Guard proposal

### 5.A Options compared

| | (a) Host-contract probe | (b) Typed host-adapter layer | (c) Contract tests importing host types | (d) Golden-shape snapshot |
|---|---|---|---|---|
| **What it catches** | Renamed/removed/added host members reachable from the live `ctx`, `agent`, `session` at probe time — **on the real deployed host** | Any shape change visible to `tsc` (renames, arity, generic constraints, removed members) | Both: `tsc` errors on drift **and** runtime assertions on values types cannot express (e.g. `'events' in session === false`) | Any difference between the committed host-surface file and the current host |
| **What it misses** | Semantic changes (same member, different behaviour); members only reachable on an unexercised code path; return shapes beyond one probe call | Runtime absence on a host build whose installed `.d.ts` is newer/older than the runtime; return-shape drift | Whatever the test does not call; needs the host packages resolvable in the test runner | Additive host changes (noisy) unless scoped to dsp's used set; nothing semantic |
| **Cost** | **Low** — 1 new src module (~120 LOC) + 1 test; no host import, no dep change | **High** — refactor ~40 access sites (slice-D counted 38 `as unknown as` + 42 structural) | **Low–moderate** — `vitest.config.ts` alias to the paths `tsconfig.json:17-46` already uses; 3–4 small test files | **Moderate** — generator + committed file + CI step; needs host source in CI |
| **Failure visibility** | Loud: one-time `console.warn` at `apply()` listing missing members + `dashboard health` returns `degraded` with the exact member names | Loudest: build fails | Loud: CI red, with the host type in the error message | CI diff |
| **Works when dsp cannot import every host package at runtime?** | **Yes** — pure reflection on live objects; zero imports | **Yes** — type-only imports already resolve via `tsconfig` `paths` | **Yes, if aliased** to the same installed host path (no new dependency); otherwise no | Only with the host present |
| **Catches the motivating bug?** | **Yes** (`.events` absent → named warning; `attachment-invalid` code list probeable) | Yes at compile time (`.events` is not on `Session`) | Yes | Yes |
| **Catches E-06 (`ignorable`)?** | Partly — can assert `KNOWN_SESSION_EVENT_TYPES.has('serenity/bound')` and that the host's `append` exposes no ignorable channel | No (the declaration merge makes dsp's `tsc` accept it) | **Yes** — a test can assert both facts directly | Yes, if the known-type set is in the snapshot |

### 5.B Recommendation

**Primary: (a) host-contract probe.** It is the only option that detects drift *in the deployed
environment*, which is where both motivating bugs actually bit; it needs no host imports (so it keeps
working under the peer-dependency-only packaging), and it converts today's silent `undefined` into a
named diagnostic on the existing `dashboard health` instrument the agent already runs.

**Complement: (c) contract tests, aliased to the host path `tsconfig` already points at.** Near-zero
cost (no new dependency — reuse `tsconfig.json:17-46`), and it is the only option that can assert the
facts types cannot express (E-06's `ignorable`/known-type gap, and that the doubles' shapes match).

**Why not (b) alone:** it is the right end state, but it is a refactor, not a guard, and it does not
help until the ~40 sites are collapsed (slice-D's work). (a) can ship independently and immediately.
**Why not (d) alone:** additive host releases make it noisy, and it detects nothing at runtime.

### 5.C Concrete file layout

```
hooks/dsh-serenity-hooks/
  src/seams/host-contract.ts          # NEW: HOST_CONTRACT table + probeHostContract(ctx, agent?, session?)
  src/tools/kit.ts                    # dashboard health → append hostContract section (degraded when missing)
  src/tools/container-admin.ts        # container_admin config --host-contract (optional on-demand view)
  src/index.ts                        # apply(): one-time console.warn on probe failure
  tests/host-contract.test.ts         # NEW: probe reports every member dsp reads; expectation list is complete
  tests/host-shape/session.test.ts    # NEW: real Session from @deepseek-ai/dsh-session
  tests/host-shape/agent.test.ts      # NEW: Agent / AgentHandle members
  tests/host-shape/settings.test.ts   # NEW: SettingsProvider.installSection; stale exports absent
  vitest.config.ts                    # + resolve.alias mirroring tsconfig paths (no new dependency)
```

`HOST_CONTRACT` shape (declarative, one row per member dsp reads):

```ts
interface HostMember { surface: string; path: string; kind: 'fn' | 'value'; source: string }
// e.g. { surface: 'ctx.tools', path: 'tools.register', kind: 'fn', source: 'api-catalog.ts:2514' }
//      { surface: 'Session',   path: 'snapshotEvents',   kind: 'fn', source: 'core/session/src/index.ts:600' }
```

`probeHostContract` returns `{ ok, missing: HostMember[], present: string[] }` and is pure (takes the
objects to inspect), so it is testable without a host.

### 5.D Minimal test additions (5 files)

1. **`tests/host-contract.test.ts`** — the expectation table covers all 10 `inject` services, all 11
   subscribed events, all 3 appended event types, and every `ctx.get?.('x')` optional service; probe
   returns `ok` for a fully-populated fake ctx and lists exactly the absent member for each of 5
   deliberately broken fakes.
2. **`tests/host-shape/session.test.ts`** — build a real `Session` via `Session.create(SessionId('x'))`
   and assert: `('events' in session) === false`; `typeof session.snapshotEvents === 'function'`;
   `session.surface.nodes` is an array; `session.append` third argument cannot carry `ignorable`;
   `KNOWN_SESSION_EVENT_TYPES.has('serenity/bound') === false` (documents E-06 and turns it into a
   failing test the moment the host adds/removes the marker mechanism).
3. **`tests/host-shape/agent.test.ts`** — assert the `Agent` members dsp uses exist, that
   `interrupt` does **not** (slice-D D-01), and that `AgentHandle` has `dispose`.
4. **`tests/host-shape/settings.test.ts`** — assert `SettingsProvider.prototype.installSection` has 5
   parameters and that `installSettingsSection` / `settingsNamespace` are **not** exports — this single
   test kills the stale mocks in 7 files.
5. **`tests/host-shape/error-codes.test.ts`** — assert the host's `RemoteErrorDetailsMap` contains
   `session/attachment-invalid` and `subagent/attachment-invalid` and does **not** contain
   `attachment-error`, replacing A-1's literal-vs-literal tautology with a host-anchored assertion.

Plus one suite-hygiene change (not a new file): delete the `.events` fallback from
`session-ops.ts:52-64` and replace every `.events` double with a `snapshotEvents()`-only double; keep a
single negative test that a `.events`-only object reads as `[]`.

---

## 6. Method & limits

**Method.** Static, read-only. The host contract was read from `AI_LAB/dsh-harness-public`
(0.1.2-rc.1) source: `packages/core/session/src/{index,types,surface,known-event-types}.ts`,
`packages/core/agent/src/{index,types,runtime-types,inbox}.ts`,
`packages/core/{tools,system-prompt,scope}/src/`, `packages/llm/llm/src/message.ts`,
`packages/settings/settings/src/index.ts`, `packages/skill/skill/src/index.ts`,
`packages/compaction/compaction/src/types.ts`,
`packages/session/session-persistence/src/coordinator.ts`,
`packages/api/session-controller/src/{types,commands}.ts`,
`packages/client/ui-conversation/src/client/contract/slots.ts`, and the generated catalog
`packages/extensions/tool-cordis/src/api-catalog.ts` (services at `:83`, events at `:2876`).
dsp's consumption was read from `src/` (95 host-import sites) and its doubles from `tests/`.

**Limits.**

1. **`bash` is disabled in this container** — no test run, no `tsc`, no live probe. All 913 tests are
   reported green by the task context, not re-verified here. Counts come from grep + reading, not from
   coverage instrumentation.
2. **The installed runtime host was not inspected.** `tsconfig.json:17-46` resolves host types to
   `~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*`, which is **outside
   the CCC root** and therefore not readable under the fs sandbox. The repo checkout at 0.1.2-rc.1 is the
   best available proxy; if the installed `.d.ts` differs, individual findings could shift.
3. **E-06 is derived from host source, not observed.** The claim is: `serenity/bound` ∉
   `KNOWN_SESSION_EVENT_TYPES` ∧ `Session.append` offers no `ignorable` channel ∧
   `assertEventsSupported` refuses unknown non-ignorable types. I did **not** observe a live load
   failure — the session store lives outside the CCC root and `bash` is disabled. Confirm before acting:
   read a stored session log containing a `serenity/bound` event in a build without dsp, or add the
   probe test in §5.D.2 and run it.
4. **Counts are of sites, not semantic distinctness.** A "site" is one literal double or one cast. Some
   `.events` occurrences in tests belong to non-`Session` objects (e.g. event arrays on records); I
   counted the ones whose object is passed where a `Session`/`Agent` is expected.
5. **No fix was applied**, per the slice's read-only mandate. `src/` and `tests/` are unmodified;
   `SESSION.md` was not touched.
6. **Sibling slices** (`slice-B`, `-D`, `-F`, `-G`, `-H`) were present in `docs/review/` at write time;
   this slice cross-references D-01/D-11–D-14 and deliberately does not restate their site tables.
