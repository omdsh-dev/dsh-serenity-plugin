# Slice B — Host Service Contracts (dsp vs DSH 0.1.2-rc.1)

> Slice: host-service access surface — every `ctx.get('<name>')` and every `ctx.<service>` dsp reaches
> into. Evidence: dsp `hooks/dsh-serenity-hooks/src` @ v1.30.5 + host source `AI_LAB/dsh-harness-public`
> @ 0.1.2-rc.1 (root `package.json:3`, and every package under `packages/` — whole tree verified rc.1).
> Motivating bug class: host removes/renames a member, dsp's `as unknown as {...}` assertion keeps
> typecheck green, runtime yields `undefined`, tests keep passing against stale doubles.

## 1. Verdict summary

| Class | Count | Meaning |
|---|---|---|
| Verified OK (name + arity + returned shape) | **38** | every audited access site matches rc.1 |
| Drifted (renamed / removed / shape mismatch) | **0** | no name, arity, or field mismatch found |
| Silent-failure risk (drift → wrong-but-quiet) | **14** | shape-agnostic read inside a blanket `try/catch` or `?? []`, no diagnostic |
| Undefined-at-runtime risk (service absent at use) | **8** | 6 non-injected services; all currently guarded, **0 crash** |

Services audited (15 distinct): `sessions`, `agents`, `tools`, `skills`, `webServer`, `settings`,
`sessionProjections`, `sessionTitle`, `tokenMeter`, `workspaceRegistry`, `sessionPersistence`,
`connection`, `codeRuntime`, `Context.emit` (cordis base), plus the **client-side** `sessions` service.

**Bottom line: no P0.** Nothing is silently wrong against rc.1 today. The systemic risk is the *mechanism*
(B-1…B-3): the assertion style plus blanket `try/catch` converts every future host shape change into a
silent empty result — exactly the class that produced the `Session.events` bug.

## 2. Verified OK

| Service | dsp site | Host declaration site |
|---|---|---|
| `ctx.sessions` (`SessionStore`) | `api.ts:163` `.get`, `api.ts:168` `.list`, `rebuild.ts:274` `.get`, `weixin-bridge.ts:398` `.list`, `skiff-debug.ts:110` `.list`, `index.ts:223` `.list`, `autopilot-trajectory.ts:417/491/525/626` `.list` | `packages/core/session/src/index.ts:36` (Context), `:861` (`super(ctx,'sessions')`), `.get` `:1119`, `.list` `:1127`, `.header` `:443`, `.id` `:449` |
| `ctx.agents` (`AgentRegistry`) | `skiff-core.ts:248` `.get`, `:282` `.create`, `:301` `.resume`; `autopilot-trajectory.ts:418/506` `.get`; `tools/handyman.ts:159` presence, `:167` `.create`; `seams/compact.ts:57` `.get` | `packages/core/agent/src/index.ts:28` (Context), `:260` (`super(ctx,'agents')`), `.create(options)` `:399`, `.resume(options)` `:418`, `.get(id)` `:577`; `AgentHandle.agent` `:166`; `meta` fields `:85-92`; `ResumeAgentOptions.resumeSessionId` `:134` |
| `Agent` members dsp reads | `id`/`session`/`ctx`/`steer`/`inject` (`seams/compact.ts:57-66`, `rebuild.ts:380-428`, `skiff-core.ts`) | `packages/core/agent/src/types.ts:14`; `runtime-types.ts:76` `session`, `:82` `ctx`, `:139` `steer`, `:149` `inject` |
| `ctx.tools` (`ToolRegistry`) | `index.ts:109` `.register`; `seams/guards.ts:272` `agent.ctx.tools.restrict`, `:356` `.guard`; `seams/system-prompt.ts:523` `.get` | `packages/core/tools/src/index.ts:130` (Context), `:820` (`super(ctx,'tools')`), `.register` `:1028`, `.restrict` `:1062`, `.guard` `:1101`, `.get` `:1195`; `ToolRestriction` `:673`, `ToolGuard` `:704` |
| `ctx.skills` (`SkillRegistry`) | `seams/opencode-skills.ts:64` `.registerProvider(() => provider)` | `packages/skill/skill/src/index.ts:286` (Context), `:376` (`super(ctx,'skills')`), `.registerProvider(create)` `:392` |
| `ctx.get('webServer')` | `gateway.ts:607` `.port` (also `index.ts:248`) | `packages/host/webserver/src/index.ts:22` (Context), `:144` (`super(ctx,'webServer')`), `.port` `:150`, `.register(route)` `:165`; `WebRoute` `:42-48` |
| `ctx.settings` (`SettingsProvider`) | `settings-section.ts:164-178` `.installSection.call(...)` | `packages/settings/settings/src/index.ts:143` (Context `settings: SettingsProvider`), `:333` abstract class, `:472` `installSection(owner, ns, schema, entry, hooks)` |
| `ctx.get('sessionProjections')` | `seams/keeper.ts:110-115` `.snapshot(session).values.contextPressure` | `packages/session/session-projection/src/index.ts:31` (Context), `:208` (`super(ctx,'sessionProjections')`); catalog `packages/extensions/tool-cordis/src/api-catalog.ts:1604` `snapshot()`; `contextPressure` **has `wire`** → `packages/llm/token-meter/src/usage-projection.ts:216-224` exposes exactly `projectedTokens`/`contextWindow` |
| `ctx.get('sessionTitle')` | `rebuild.ts:372-380` `.rename(session, title)`; `tools/session.ts:184-193` `.rename` | `packages/session/session-title/src/index.ts:66` (Context), `:311` (`super(ctx,'sessionTitle')`), `.rename(session,title)` `:400`, `.get(session)` `:385` |
| `ctx.get('tokenMeter')` | `rebuild.ts:414-420` `.estimateMessage(message)` | `packages/llm/token-meter/src/index.ts:88` (Context), `:105` (`super(ctx,'tokenMeter')`), `.estimateMessage(message)` `:198`, `.measure(session, requestHeader?)` `:139` |
| `ctx.get('workspaceRegistry')` | `api.ts:335-338` `.list()`; `skiff-debug.ts:89-92` `.list()` | `packages/workspace/workspace/src/index.ts:68` (Context), `:115` (`super(ctx,'workspaceRegistry')`), `.list(): Workspace[]` `:181`; `Workspace.path` `types.ts:40`, `.title` `:43` |
| `ctx.get('sessionPersistence')` | `skiff-debug.ts:99-102` `await .list()` | `packages/session/session-persistence/src/index.ts:99` (Context), `:124` (`super(ctx,'sessionPersistence')`); catalog `:1530` `list(signal?): Promise<SessionHeader[]>` |
| `ctx.get('connection')` | `gateway.ts:566-580` `.authenticatedUrl`, `.authorizeIndex` | `packages/client/connection/src/rpc-host.ts:51` (Context `connection: HostConnectionHandle`), `:74` (`super(ctx,'connection')`), `.authorizeIndex` `:102`, `.authenticatedUrl` `:107` |
| `ctx.get('codeRuntime')` | `api.ts:281-284` `.language`, `.isolation` | `packages/code-runtime/code-runtime/src/index.ts:90` (Context), `:123` (`super(ctx,'codeRuntime')`), `.language` `:112`, `.isolation` `:120` |
| `ctx.emit(...)` | `api.ts:351` `'serenity/config-updated'`; `settings-section.ts:158` `'serenity/settings-changed'` | cordis base mixin `vendor/cordis/src/reflect.ts:222`, `vendor/cordis/src/events.ts:194`; events declared by dsp `gateway.ts:94-99` (`declare module 'cordis'`) and listened `gateway.ts:680/687`, `index.ts:206/281` |
| `ctx.sessions.binding(id)` (**client** plugin) | `client/image-fallback-api.ts:103` | `packages/api/session-controller/src/client/contract/sessions.ts:122`; impl `src/client/sessions/service.ts:509`. Host-side `SessionStore` has **no** `binding()` — correct that dsp calls it only in the client half, whose `inject` names `sessions` (`client/index.ts:34`) |

Type-identity check (prerequisite for all of the above): dsp imports `from 'cordis'` while host packages
declare `declare module '@deepseek-ai/cordis'`. `tsconfig.json:42-43` aliases **both** specifiers to the same
installed `@deepseek-ai/cordis`, so the augmentations (`ctx.sessions`, `ctx.agents`, `ctx.tools`,
`ctx.skills`, `ctx.webServer`, `ctx.settings`, `ctx.connection`, …) genuinely apply — that is why
`index.ts:109` `ctx.tools.register(...)` typechecks with no cast.

## 3. Findings

| ID | Severity | Service | Evidence (dsp:line + host:line) | Failure mode | Fix |
|---|---|---|---|---|---|
| **B-1** | **P1** | `ctx.sessions` (`SessionStore.list()`) | dsp `api.ts:168-176` (representative) + `index.ts:223-233`, `skiff-debug.ts:110-114`, `weixin-bridge.ts:398-405`, `autopilot-trajectory.ts:417-441`, `:491-512`, `:525-532`, `:626-638`; host `core/session/src/index.ts:1127` | **silent** | 8 sites read `(sessions as unknown as {list?: () => Array<...>}).list?.() ?? []` inside a `try/catch {}`. If `list()` ever changes arity/shape (or becomes async, as `sessionPersistence.list()` already is), the `.map`/iteration throws, the catch swallows it, and the caller proceeds with **"no live sessions"** — `api.ts:177` then silently resolves the workspace to `process.cwd()`, i.e. wrong CCC for status/safe-mode. Fix: drop the cast (`ctx.sessions` is injected → typed `Session[]`), and log the caught error instead of a bare comment. |
| **B-2** | **P1** | `ctx.get('workspaceRegistry')` | dsp `api.ts:335-341`, `skiff-debug.ts:89-95`; host `workspace/workspace/src/index.ts:181` | **silent** | Same shape-agnostic pattern: `registry?.list?.() ?? []` in a `try/catch`. Drift (rename, async, `{items}` wrapper) → empty `knownWorkspaces`, so the WebUI account editor silently shows "no selectable workspace" and CCC auto-discovery silently finds nothing. Fix: typed `ctx.get('workspaceRegistry')` (host returns `Workspace[]` synchronously) + log the catch. |
| **B-3** | **P1** | `Context.get` typing on **non-injected** services | dsp `seams/keeper.ts:110`, `rebuild.ts:372`, `rebuild.ts:414`, `tools/session.ts:184`, `gateway.ts:566`, `gateway.ts:607`, `api.ts:335`, `skiff-debug.ts:89`, `skiff-debug.ts:99`, `api.ts:281`; host `vendor/cordis/src/reflect.ts:17` | **silent** | cordis already types the lookup: `get<K extends string & keyof this>(name: K, strict?: boolean): undefined \| this[K]`. dsp instead casts to `{ get?: (name: string) => unknown }`, which (a) erases the return type into `unknown` → a second hand-written assertion, (b) erases the `undefined` union so the real optionality is invisible, and (c) lets a renamed method compile silently — the `?.` on `get` is dead weight (the method always exists), while the *result* is what can be undefined. Fix: delete the casts and read `ctx.get('sessionTitle')` / `ctx.get('tokenMeter')` / … directly; keep the existing `typeof x.method !== 'function'` guards where they produce a diagnostic. |
| **B-4** | P2 | `sessionTitle` | dsp `rebuild.ts:372-378`, `tools/session.ts:184-193`; host `session/session-title/src/index.ts:400` | **loud** (warn) | Guard is correct: absent service → `console.warn('…sessionTitle 服务不可用')` then skip. Only hygiene: the assertion is unnecessary (B-3). `rename` also throws when the session is not live (`catalog:1890`), and dsp wraps it in try/catch — acceptable. |
| **B-5** | P2 | `tokenMeter` | dsp `rebuild.ts:414-420` + `:322-338`; host `llm/token-meter/src/index.ts:198` | **silent** | Absent/renamed `estimateMessage` → `meter = undefined` → `performRebuild(..., undefined)` skips the shadow-price append anchor (documented at `rebuild.ts:310-318`) with **no diagnostic**: token accounting drifts quietly. Fix: one `console.warn` when `meter` is unavailable. |
| **B-6** | P2 | `connection` | dsp `gateway.ts:566-591`; host `client/connection/src/rpc-host.ts:102/107` | **semi-loud** | Correct design: re-reads `ctx.get('connection')` per call (comment `:556-558` — `connection` may not exist during early `apply`), logs once whether present/absent, then returns `undefined`. Risk: after the single diagnostic, a renamed `authorizeIndex`/`authenticatedUrl` degrades to no cookie injection → reverse-proxy 401s with no further log. Fix: warn on each transition to the degraded state, not once per process. |
| **B-7** | P2 | `codeRuntime` | dsp `api.ts:281-285`; host `code-runtime/code-runtime/src/index.ts:112/120` | **benign silent** | Absent → `codeRuntime: null` in the status JSON (UI hint only). Hygiene: drop the assertion, `ctx.get('codeRuntime')` is already typed. |
| **B-8** | P2 | `settings` | dsp `settings-section.ts:164-183`; host `settings/settings/src/index.ts:472` | **silent** | When `ctx.settings` is absent dsp silently swaps the source to `{}` and fires `onChange` (comment `:181`), so every Serenity toggle silently falls back to defaults with no log. Unreachable while `settings` is in `inject` (`index.ts:52`), but it is the silent-fallback shape. Fix: warn once in that branch. |
| **B-9** | P2 | `ctx.agents.resume` | dsp `skiff-core.ts:301-312`; host `core/agent/src/index.ts:418` | **silent** | `typeof agentsWithResume.resume !== 'function'` is dead code in rc.1 (`resume` is an unconditional class method), but if a future host renames it the guard silently routes to `ctx.agents.create({...})` → a **new session instead of a resume**, i.e. a silently forked trajectory. Fix: log when falling back to create. (Arity note: the registry method is 1-arg `resume(options)`; the 2-arg `resume(ownerCtx, options)` at `:206` is the *factory* interface. dsp's 1-arg call is correct.) |
| **B-10** | P2 | `sessionProjections` (already injected) | dsp `seams/keeper.ts:110-118`; host `session/session-projection/src/index.ts:208` + `index.ts:52` inject | **benign silent** | `sessionProjections` is in dsp's `inject`, so `ctx.sessionProjections.snapshot(session)` is typed and non-optional; the `ctx.get(...)` + assertion is pure noise. Fix: use the injected typed property. |
| **B-11** | P2 | client `ctx.sessions.binding` | dsp `client/image-fallback-api.ts:103`; host `api/session-controller/src/client/contract/sessions.ts:122` | **loud** (throws) | Correct: absent binding → explicit `throw new Error('serenity image fallback: session unavailable')` (`:105`). Hygiene: `client/index.ts:34` injects `sessions`, so the cast can go. |

## 4. Unused host services worth adopting

| Service | What it removes / adds | Effort |
|---|---|---|
| `ctx.sessionQuery` — `readTitle(sessionId)` (catalog `:1690`), `listSessions()` `:1671`, `readSession(sessionId)` `:1677` | **Removes the hand-rolled title fold**: `autopilot-trajectory.ts:462-475` scans `sessionEvents()` backwards for `session/title`; `session-bound.ts:80` reads the same event stream. That scan *is* the `.events` → `snapshotEvents()` drift surface (the motivating bug). Also adds live-preferred reads of **persisted** sessions, which dsp cannot see today. | medium (async API; current callers are sync) |
| `ctx.sessionTitle.get(session)` (host `session-title/src/index.ts:385`) | **Removes the same events scan for the live case** with no async hop — a direct, typed read of the folded title. | low |
| `ctx.workspaceRegistry.resolveByPath(path)` (catalog `:2866`), `get(id)` `:2836`, `create(path,title)` `:2830` | **Replaces list-all-and-filter discovery** in `skiff-debug.ts:80-122` (and `api.ts:338`) with a direct canonical-path lookup; also lets CCC discovery register a workspace instead of only reading them. | low |
| `ctx.sessionPersistence.readRaw(id)` / `supportsRawArtifacts` (catalog `:1478`/`:1473`) | **Adds** reading a persisted/archived session's verbatim log without making it live — dsp's session tooling (`autopilot-trajectory.ts`, `session-ops.ts`) only sees live `Session` objects today. | medium |
| `ctx.shell` — `resolve(request)` / `run(spec)` / `start(spec)` (catalog `:2029-2045`) | **Removes 7 raw `node:child_process` modules**: `msm-ops.ts:17` (plus the platform-specific bun/npx handling at `:90`, `:693-702`), `git-ops.ts:14`, `fs-ops.ts:30` (reveal), `weixin-hook.ts:17`, `autopilot-trajectory.ts:33`, `tools/autopilot-trajectory.ts:18`. Gains host-owned timeouts, output spill, and background-process teardown. **Caveat:** it also routes MSM/git execution through DSH shell policy — a deliberate behavior change for CCC MSMs that intentionally run outside the agent's tool sandbox. | high |
| `ctx.subagents` — `startContinuable` / `sendMessage` / `interrupt` (catalog `:2191/2198/2205`) | **Replaces handyman's hand-rolled worker loop**: `tools/handyman.ts:167` creates agents via `ctx.agents.create({meta:{origin:'subagent'}})` and drives rounds by polling `agent/status` (`:67`) with progress files. The official seam gives durable continuable children, steering, and interrupt/drain. | high |
| `ctx.attachments` — `imageLimits` / `validateImage` / `readImageRequest` (catalog `:469/474/506`) | **Adds** pre-flight image validation to the client image fallback, which today reacts after the fact to `MODEL_DOES_NOT_SUPPORT_IMAGES` (`client/image-fallback-api.ts`). Thin benefit — listed for completeness. | medium |

Explicitly **not** recommended: `ctx.sessionProjections.stateOf` (dsp correctly uses `snapshot()` for
`contextPressure`, a wire unit); `ctx.workspaceController` / `ctx.sessionController` (Remote-facing faces
for the generated `ctx.remote.*` namespaces — dsp's host-side code should stay on
`workspaceRegistry`/`sessions`).

## 5. Method & limits

- **Read (dsp, full or targeted):** `index.ts` (1-130, 215-264), `seams/keeper.ts:95-139`,
  `seams/compact.ts:40-69`, `seams/opencode-skills.ts` (full), `rebuild.ts:260-289, 360-429`,
  `tools/session.ts:170-209`, `gateway.ts:550-619`, `api.ts:155-194, 275-364, 725-754`,
  `skiff-debug.ts:75-134`, `settings-section.ts:140-184`, `skiff-core.ts:270-344`,
  `autopilot-trajectory.ts:410-534, 618-642`, `tools/handyman.ts:152-186`, `weixin-bridge.ts:390-414`,
  `client/image-fallback-api.ts:75-108`, `package.json` (full), `tsconfig.json` (full). Greps for
  `ctx.get(`, `as unknown as {`, `ctx.(sessions|agents|emit|tools|skills)`, `node:child_process`,
  `declare module`, `ctx.on(`.
- **Read (host, rc.1):** `packages/core/session/src/index.ts` (Context/get/list/header/id),
  `core/agent/src/index.ts` (Context/create/resume/get/AgentHandle/meta), `core/agent/src/types.ts`,
  `core/agent/src/runtime-types.ts:40-149`, `core/tools/src/index.ts:1045-1104`,
  `host/webserver/src/index.ts:1-183`, `settings/settings/src/index.ts:140-164, 333-352, 462-496`,
  `workspace/workspace/src/{index.ts,types.ts}`, `session/session-title/src/index.ts`,
  `session/session-projection` + `session/session-persistence` declarations,
  `llm/token-meter/src/{index.ts,usage-projection.ts}`, `client/connection/src/rpc-host.ts:45-108`,
  `code-runtime/code-runtime/src/{index.ts,types.ts}`, `skill/skill/src/index.ts:286-424`,
  `api/session-controller/src/client/contract/sessions.ts:100-123`,
  `vendor/cordis/src/{reflect.ts,events.ts}`, `packages/extensions/tool-cordis/src/api-catalog.ts`
  (service entries), `packages/AGENTS.md` (optional-service / `ctx.get` rule).
- **Version check:** every `packages/*/*/package.json` in `AI_LAB/dsh-harness-public` reports
  `0.1.2-rc.1` (spot-verified root, `core/session`, `core/agent`, and the full grep sweep).
- **Limits / not verified:** (a) the *installed* host under
  `~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/…` is **outside the CCC root and was not
  read** (path isolation); conclusions rest on the in-CCC host source copy at 0.1.2-rc.1, which is the
  version dsp's `tsconfig` paths point at. (b) No typecheck or test run (read-only slice); "no drift" is a
  source-level verdict, not a compile verdict. (c) Runtime *timing* of `ctx.get` was reasoned from
  `vendor/cordis/src/reflect.ts:237-243` (`strict` → only ACTIVE provider fibers) plus dsp's guards, not
  observed live. (d) `Session.events`/`snapshotEvents` (the motivating bug) is Slice A's surface; it appears
  here only as the reason B-1/B-2/B-3 are rated P1.
- **No source modified.** Only this file was written.
