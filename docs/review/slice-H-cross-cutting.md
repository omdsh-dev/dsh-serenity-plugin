# Slice H — Cross-Cutting Observations (main thread)

> Reviewer: main thread (S142). These are system-level observations that the six specialist slices
> (A–F) do not own by construction: they concern *how the plugin as a whole meets the host*, not any
> single contract. Every item is evidenced; items I could not verify are marked as such.

## H-1 — `apply()` has no per-subsystem failure isolation (severity P1)

**Evidence.** `src/index.ts:107-175` is a straight-line sequence of ~20 `register*` calls with no
`try/catch` and no ordering guarantee beyond source order: tools (108-121) → guards → keeper → context →
entry-skill section → compact → api → settings → gateway → rebuild → output-guard → env → opencode-skills
→ bootstrap → skiff → acp → autopilot → weixin.

**Host semantics (verified).** A throw anywhere inside a plugin's `apply` is fatal to the *whole boot*:
`packages/boot/app-boot/src/index.ts:674-677` throws
`"plugin(s) failed to load: <names>; Cordis startup failed because these plugin(s) could not be resolved"`,
and the boot tests assert the process "rejects (never exits 0 half-empty)"
(`packages/boot/app-boot/tests/app-boot.spec.ts:719`, `:434`).

**Consequence.** One host-contract drift inside any single seam (e.g. `ctx.settings.installSection`
signature change in `registerSettingsSection`) takes down **all of dsh web**, not just that feature. The
failure is loud but catastrophic, and the operator gets one aggregate error naming the plugin, not the
subsystem. Conversely, drifts that do *not* throw (renamed event, renamed service) produce a silently
partial ACC with no signal at all — the two failure modes are at opposite extremes with nothing in between.

**Proposed fix (for review, not applied).** Wrap each `register*` in a small helper that records
`{subsystem, ok, error}` into a per-process registry, continues on failure, and surfaces the result through
`dashboard health` (a new `subsystems` section) plus one warning line at load. Keep tools first so the ACC
core survives a later seam failure. Rationale: an ACC whose injection silently vanished is worse than an
ACC that reports "seam X degraded".

## H-2 — The host version is already read, but never checked (severity P1 — cheapest systemic guard)

**Evidence.** `src/status.ts:28-46` `readDshVersion()` reads the installed host's `package.json` across
three platform-specific prefixes (npm_config_prefix / APPDATA / `~/.npm-global`), and the value is surfaced
as `dshVersion` in `dashboard health` (`src/kit-ops.ts:189`, `src/status.ts:51,72`). Nothing anywhere
compares it against the range dsp actually requires (`package.json:54-71` `^0.1.2-rc.1`), and the host does
not enforce `engines.dsh` either (slice G, G-1).

**Consequence.** The single cheapest detector of the v1.30.5 bug class is already implemented and unused:
the plugin can know the host version and say "this host is outside the contract range I was verified
against". Today the only way to discover a contract break is a user bug report.

**Proposed fix.** On startup (and in `dashboard health`), compare `readDshVersion()` against a single
declared required range and report `hostContract: ok | unsupported(host=X required=Y)`. Pair it with the
shape probe from slice E so *presence* (not just version) is checked.

## H-3 — No CI; the 913-test suite is opt-in (severity P1 process)

**Evidence.** `AI_LAB/dsh-serenity-plugin/` contains no `.github/workflows` (glob over the repo returns
only unrelated `node_modules` YAML). The only automated gate on the release path is inside `dsh-develop
publish`, which runs typecheck + build + tarball check — **not** `test` (observed in the v1.30.5 publish
output: typecheck ✓ / build ✓ / tarball ✓ / published).

**Consequence.** Verification depends on a human or agent remembering to run `dsh-develop test` before
`publish`. A green-looking publish can ship failing tests, and host-contract regressions have no automated
detector at all.

**Proposed fix.** Add a workflow that runs `typecheck + test` on push/PR (GitHub-hosted runner, no secrets
needed for the test job), and make `dsh-develop publish` refuse to publish when the suite is red.

## H-4 — Two host-access styles with different guarantees (severity P2, feeds the adapter design)

**Evidence.** `src/index.ts:52` declares `inject = ['tools','webServer','sessions','shellEnv','skills',
'agentLoop','agents','systemPrompt','sessionProjections','settings']` — the only services the plugin
*requires*. Everything else is fetched lazily behind assertions and optional chaining:
`ctx.get('sessionTitle'|'tokenMeter'|'connection'|'workspaceRegistry'|'sessionPersistence'|...)`, and
`ctx.sessions` / `ctx.agents` / `ctx.emit` (35 assertion sites; slice D audits each). Lazy access silently
degrades: e.g. `readWebPort()` (`src/index.ts:246-253`) swallows any error and returns 3080.

**Consequence.** There is no single place that states, let alone verifies, dsp's full host dependency set:
`inject` covers 10 services; the other ~7 are implicit. A host rename of a lazy service yields a silent
fallback instead of a diagnosable failure.

**Proposed fix.** One host-adapter module that owns every host access, declares the *complete* dependency
set (required vs optional, with the fallback policy per entry), and exposes the shape probe of slice E.
`inject` becomes derived from that declaration instead of hand-maintained.

## H-5 — Teardown coverage unverified (open item)

Servers are started in several places (`startSkiffDebugServer`, `startAcpHttpServer`, gateway's second
listener) via settings-change handlers, and `stop*` functions exist, but `apply()` registers no explicit
dispose that guarantees they stop on plugin unload/reload. Whether cordis's own disposal covers them
(sockets vs fiber lifetime) is **not verified here** — flagged for slice A (dispose/leak check) and for the
fix round; if unverified after A, it should be probed deliberately (reload the plugin and observe ports).

## Method & limits

- Read: `src/index.ts` (full), `src/status.ts:1-50`; host `packages/boot/app-boot/src/index.ts` (grep +
  line 674-677 context) and its tests; repo-wide globs for CI/YAML and templates.
- Not verified: cordis's treatment of `ctx.on('<unknown-event>')` at runtime (whether it throws or silently
  no-ops) — decisive for the severity of event-name drift; owned by slice A. Plugin-dispose semantics
  (H-5).
- No source modified.
