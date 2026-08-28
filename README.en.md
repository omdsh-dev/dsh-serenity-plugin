# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **Not a sandbox — a cognitive container.**
> A Serenity ACC (Abstract Cognitive Container) implementation for the DeepSeek Harness (DSH): it turns any DSH session into a place where **cognition happens, is stored, and happens again**.
>
> Targets [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc and later.

## The cognitive container: what this plugin is about

> Theoretical foundation: [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) §0 (the cognitive-container standard, v1.3.1).

**A cognitive container is a place where cognition happens, is stored, and happens again.** This plugin turns any directory marked with `.serenity` (a CCC, Concrete Cognitive Container) into such a container:

| Cognitive stage | Mechanism |
|-----------------|-----------|
| **Happens** | Cognition proceeds as a Loop — each agent turn is one iteration; every external interaction in the loop (tool calls, waiting for the user, system events) **is feedback**, the loop sampling the world to verify its endogenous predictions |
| **Is stored** | The trajectory persists — `SESSION.md` is the trajectory's **persistent body** (never moves), `AGENT_SESSIONS/` is its repository |
| **Happens again** | The trajectory is pushed forward by new agents — `session_rebuild` (Ship of Theseus): the carrier is rebuildable, the identity never changes |

Core insight:

```
Trajectory (the subject — an existence across time)
    ↑ pushed by some Agent
Session (the carrier — rebuildable; the trajectory's current embodiment)
LLM / Runtime / Tools (the cognitive medium — replaceable)
```

- **Agents are replaceable; the trajectory is continuous** — the LLM is a cognitive medium, not a brain; an agent is a role in the process; `SESSION.md` is the trajectory's persistent body, and the working session (the dsh conversation) is its rebuildable running copy
- **Cognitive closure**: human intervention is just one feedback input to the trajectory (homogeneous with tool calls) — under the trajectory-subject + relative-time view, Serenity already realizes a **human-LLM collaborative loop**
- **Collaboration scale is bounded by trajectory continuity, not by any single agent's lifetime** — as long as the trajectory is continuous, the agents, models, and hosts involved can all be replaced

## What this repository is

[opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) is the Serenity ACC for OpenCode; this repository is an **independent implementation for DSH**.

- **Independent**: does not reuse opencode-serenity-plugin source; aligns to the same ACC standard (tool set + mechanical guards + collaboration discipline), with the injected system prompt **byte-aligned on platform-neutral text** (see below).
- **Primary artifact = native Cordis plugin** (`@shgroup/dsh-serenity-hooks`): real DSH tools (registered in-process via `ctx.tools.register`) + interception-seam mechanical constraints — the official DSH extension form (isomorphic with the harness's own 200+ packages).
- **Knowledge layer = skills** (acc-serenity etc.): knowledge only; constraints are enforced mechanically by the plugin.
- **Platform reuse**: path guards (fs sandbox), loops/residents (goal/subagent), compaction retention are native DSH capabilities reused as-is.

## Features

| Capability | Description |
|-----------|-------------|
| **11 real DSH tools** | `cc_fs` (15 fs subcommands) / `session` (full session lifecycle) / `acc_kit` / `cc_git` / `acc_msm` (MSM framework) / `eap` / `neat` / `cce` / `handyman` (whitelisted-model worker loop + parallel jobs) / `session_rebuild` (trajectory-tracker reset) / `localstore` — all registered via `ctx.tools.register` |
| **System-prompt injection (8 blocks)** | `systemPrompt.section` (global, order -50): `=== Serenity ACC ===` / `=== Serenity Metaphor ===` (world model: Ship/Voyage/Crew) / `=== Serenity Principles ===` (cognitive-container ontology + MSM principles) / `=== Serenity CCE ===` / `=== Serenity EAP ===` / state blocks (Safe Mode / Localstore) / top-level entry skill full text (via the `.serenity` marker) / `=== Serenity Session ===` — aligned to opencode-serenity-plugin, byte-identical on platform-neutral text |
| **first-anchor (zero-config)** | Every CCC is Serenity/ACC at the abstraction layer — new sessions get 2 protocol anchor messages (ACC identity + collaboration protocol), acknowledge with 0 tools, then promote to the full tool catalog; mechanism and content are code-fixed, no CCC config surface |
| **Interception-seam guards** | safe-mode (bash disappears from the tool list) / path-escape blocking (P3: full inside Root, zero outside) / blacklist / governance-file protection / Trajectory-Steward DCP reminders — not bypassable by the model |
| **session_rebuild trajectory tracker** | Context pressure over threshold → LLM-triggered `session_rebuild`: same-session surface wipe (Ship of Theseus), anchor keeps first-anchor protocol text + "continue S###", **auto-resumes** (steer) without user input; SESSION.md persists in place; shadow-price protocol compliant (token-meter accounting resets correctly) |
| **Trajectory Steward** | A scoring reminder mechanism (`[TRAJECTORY-STEWARD]` + ACK protocol) that urges the agent to record progress back into SESSION.md — the mechanism is pre-declared in the system prompt before any reminder fires |
| **Dual-port gateway (external access)** | Second node:http listener (default 0.0.0.0:3081) + login page (scrypt password **OR** TOTP code, either works + QR-code TOTP binding + CSRF token store + exponential lockout) + HttpOnly cookie (sliding 24h) + reverse proxy to the main port (Host/Origin rewritten to pass the trust fence) + WS forwarding + workspace allowlist |
| **Image auto-fallback** | When the model does not support images: paste → saved to `_tmp/images_from_user/` → resent as text with the path → the agent uses the CCC's own vlm MSM |
| **Any-file paste auto-save** | Pasting a non-image file → auto-saved to `_tmp/files_from_user/` (executable extensions blocked + 10MB cap + filename sanitized) + the input draft gets a path note (sent with the message) → the agent processes it with CCC MSMs (PDF extraction / archive unpack / spreadsheet parsing) |
| **persona easter-egg mode** | Plugin settings can replace the output/instruction-following constraints of the ACC system prompt (EAP block + MSM principles) — a configured persona text replaces the defaults; unconfigured, behavior is exactly the default |
| **Compaction retention** | Re-injects ACC identity after `compaction/end` (compaction never loses CCC constraints) |
| **WebUI status badge + panels** | Session-header status badge (**capsule v1.24.10**: 999px full-round pill + always-green dot + SAFE shield slider with emerald gradient + Mac-style quick toggle) + click to open a self-drawn popover (CCC status card); DSH settings panel hosts plugin switches/thresholds/external access |
| **Activation gating** | Everything activates only inside a CCC directory marked with `.serenity`; zero effect on DSH behavior elsewhere |

## Why MSM beats bash — why safe-mode exists

> Safe-mode exists not because disabling bash is convenient,
> but because **written and tested MSMs are more reliable and safer than raw bash**.

| Dimension | Raw bash | Written-and-tested MSM |
|-----------|----------|------------------------|
| **Determinism** | Every command is new; results depend on environment, cwd, timing | Pure TS script; same input → same output; unit-testable (vitest) |
| **Safety boundary** | No built-in constraints; path/scope rely on prompt discipline | Registry + path-escape validation + 600s timeout kill |
| **Auditability** | Call-and-gone, no trace | Registry + exit-code protocol (0/1/2) + paired tests |
| **Self-description** | `--help` written and forgotten | `--schema` / `--list` protocol self-description |
| **Reliable execution** | Deadlock/hang needs humans | Async (no event-loop block) + timeout auto-kill |

Turning safe-mode on makes bash **disappear from the model's tool list** (via DSH `tools.restrict`, refreshed each step) — not an error on call, the model simply never sees it. The agent is forced onto the MSM whitelist channel: registered, tested, bounded, deterministic operations. The toggle is a **user capability** (WebUI only; invisible to and not controllable by the agent).

## Best practice: a home cognitive infrastructure

> Modeled on the real "Serenity" deployment (all addresses/accounts/paths/keys in this section are genericized — no private data).
> A directory marked with `.serenity` is a CCC. This section shows what the system **really does** — each use case includes the concrete tool chain, ready to follow.

### 1. Anatomy of a CCC

```
home-serenity/                    ← CCC root (marked by the .serenity file)
├── .serenity                     ← the marker: this directory is a cognitive container
├── .opencode/
│   ├── serenity.json             ← CCC-level config: handyman model whitelist / thresholds / blacklist
│   └── skills/                   ← domain skills (each = an EAP-encapsulated body of knowledge)
│       ├── home-media/           ←   media: acquisition / subtitles / distribution
│       ├── home-wealth/          ←   finance: assets / liabilities / income / budget
│       ├── family-profiles/      ←   member profiles (single source of truth)
│       └── … (each skill may own MSM scripts)
├── AGENT_SESSIONS/               ← session repository: one SESSION.md per directory
│   └── 2026-08-27--S142--xxx/
│       └── SESSION.md            ← trajectory body: goals / decisions / progress (never moves)
└── _tmp/                         ← runtime drops (images / user-pasted files)
    ├── images_from_user/
    └── files_from_user/
```

### 2. What you can do day-to-day (real use cases, with operation chains)

| # | Scenario | Operation chain (tool → subcommand → effect) |
|---|----------|----------------------------------------------|
| 1 | **Long-running project maintenance** | `session create --desc xxx` → auto-creates `YYYY-MM-DD--S###--xxx/SESSION.md` → record progress step by step → `session use` resumes after interruption → `session_rebuild` auto-continues from the trajectory when context overflows (Ship of Theseus) |
| 2 | **Batch code sync** | Root repo: `cc_git commit/push`; sub-repos: one-shot `resources-management sync` (auto commit + push all); multi-repo status via `status --all` |
| 3 | **Media subtitle production** | Find source (BT) → download → Whisper transcription → LLM translation → bilingual SRT → mechanical QC (7 checks: timeline/duration/CPS/alignment) → distribution (RSS/email) |
| 4 | **Server inspection** | `server-tool health` → one-shot report of CPU/memory/GPU/containers/services; `server-tool container` inspect/restart; `server-tool vllm` query inference service; all through the ssh-connect whitelist channel |
| 5 | **LAN service discovery** | `landscape-tool` repo panorama (20+ repos classified by domain/stack/relations); `network-tool` device/port scanning — answers "which machine runs service X, on what port" |
| 6 | **Finance data management** | Locally structured assets/liabilities/income/expenses/budget → query/aggregate; macro-tracking framework (optional external rate data, e.g. mortgage-rate comparison tool) |
| 7 | **Member profiles** | `profile list/show/create/update` — member data maintained centrally; the CCC is the single source of truth |
| 8 | **Capture ideas on the fly** | Chat whenever an idea comes → the AI interviews you into clarity → structured archive → periodic review of thinking patterns |
| 9 | **External access (phone / travel)** | Browser → `http://lan-address:3081` → login page: username + password **OR** an Authenticator 6-digit code (either works) → operate the WebUI from your phone; accounts managed in the settings panel (password + QR-code TOTP binding + 5-failure lockout for 15 min) |
| 10 | **Pasted material auto-processing** | **Images**: paste → auto-saved to `_tmp/images_from_user/` → vision model recognition (courier slips / screenshots / charts) → usable right in the conversation; **any file**: paste a PDF/archive/document → auto-saved to `_tmp/files_from_user/` → the agent extracts automatically (PDF extraction / archive unpack / spreadsheet parsing — dedicated MSMs for each) |

### 3. What you manage (governance, with mechanism details)

| Governance object | Mechanism details |
|-------------------|-------------------|
| **Executable units** | `acc_msm list` full registry; `acc_msm check` quality (4 DC checks: has tests / has main guard / bidirectional references consistent / path-type flags guarded); `register/deregister` management — everything is registered, tested, self-describing |
| **Cognitive quality** | Periodic SQC scan → every skill stays EAP-compliant (Explicit / Reconstructable / Stable); design collaboration follows the Neat protocol (small steps / explicit decisions / document-driven) |
| **Safe mode** | One click in the WebUI → bash **disappears** from the model's tool list (not an error) → the agent can only use registered MSMs; the toggle is a user capability — invisible to and not controllable by the agent |
| **Credentials** | `localstore.json` centralizes credentials/keys (git refuses to commit by default — physical guarantee); `credential list/get` for unified reads |
| **External-access security** | Login hardening (scrypt + constant-time compare + 256-bit token + sliding 24h); QR-code TOTP binding (rendered QR); failure lockout (5 → 15min exponential backoff); server-side CSRF token store (multi-tab safe); workspace allowlist (only allowed workspaces visible externally) |
| **Session repository** | Full lifecycle: create / show / health (stale/stalled/drift) / qa (fact check) / archive — every piece of work traceable and rebuildable |
| **Context hygiene** | Trajectory Steward scoring reminders (over threshold → urged to record progress back into SESSION.md); rebuild hints on context overflow (threshold adjustable in the settings panel) |

### 4. A typical day (scenarios chained)

```
Morning:  LAN service inspection (server-tool health) → all healthy, no action
Forenoon: sync yesterday's code (resources-management sync) → all sub-repos pushed
Noon:     a PDF bill arrives → paste into the conversation → auto-saved + table extracted → recorded into finance data
Afternoon: produce a video's subtitles (Whisper → translate → bilingual SRT → QC) → push to subscribers
Evening:  access home services from an external device (login with a TOTP code) → handle an ops issue
Throughout: every piece of work lands in SESSION.md → the trajectory stays continuous,
            ready for anyone/model/host to pick up at any time
```

## Feature details

## Quick start

Prereqs: Node ≥ 20 (or bun), DSH 0.1.0-rc+, pnpm.

### Option 1: npm install (recommended, published on the npm registry)

```bash
# 1. Install the plugin from the npm registry into a DSH profile (auto-joins the bundles layer)
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. Restart dsh web (activates the plugin and its WebUI client)
dsh web
```

`dsh plugin` detects the package's `dsh.bundle` declaration and activates the config layer automatically — no hand-written configuration. To uninstall:

```bash
dsh plugin --profile web remove @shgroup/dsh-serenity-hooks
```

### Option 2: install from GitHub source (clone + link into the hooks subpackage)

```bash
# 1. Clone the public repo
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin

# 2. Link-install the hooks subpackage (the npm publish unit is hooks/dsh-serenity-hooks;
#    the repo-root package is not a plugin)
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks

# 3. Restart dsh web
dsh web
```

> ⚠️ Do **not** use `dsh plugin add github:tellmewhattodo/dsh-serenity-plugin` — a git URL can only point at the repo root, and the root package (`@shgroup/dsh-serenity-plugin`) is a workspace container, not a bundle-layer plugin; installing it activates nothing. A git install fetches sources: the author ships a self-contained `prepare` build (this package does — full Node + client double bundle), and the user must allow the build script under `allowBuilds` in the profile's `pnpm-workspace.yaml`.

### Option 3: local development install (same repo)

```bash
dsh plugin --profile web add link:<this-repo>/hooks/dsh-serenity-hooks
```

### After install

```bash
# Install knowledge skills into the target CCC (directory with a .serenity marker)
dsh-serenity-plugin install --scope ccc

# Check activation
dsh-serenity-plugin status
```

Sessions inside a CCC automatically get: the 11 ACC tools, mechanical guards, ACC identity injection, first-anchor anchoring, entry-skill system prompt, Trajectory-Steward reminders, and the WebUI status badge.

## Feature details

### Tools ×11

| Tool | Capability | Notes |
|------|-----------|-------|
| `cc_fs` | 15 subcommands | root / resolve / exists / list / tree / relative / mkdir / rm / mv / cp / touch / append / reveal / info / find; path-escape blocking + root protection + `regex:` find |
| `session` | 9 subcommands | list / show / create / use / close / health / qa / archive / summary; full `AGENT_SESSIONS/` lifecycle with automatic S###; `use` also renames the dsh session (S###-date) |
| `acc_kit` | 3 subcommands | health (CCC 3 principles) / time / wait |
| `cc_git` | 5 subcommands | status / commit / push / log / pull; non-fast-forward push prints advice (never force) |
| `acc_msm` | 7 subcommands | list / exec / register / deregister / check / guide / ccc-config; async execution + 600s timeout kill |
| `eap` | progressive disclosure | EAP cognitive-quality framework |
| `neat` | progressive disclosure | Neat design-collaboration protocol |
| `cce` | progressive disclosure | Cognitive Continuity Engineering |
| `handyman` | worker loop | synchronous round-loop of a dedicated worker agent on a CCC-whitelisted model until done; parallel jobs orchestration (maxParallel, default 10); resumable progress files; auto-restart on abnormal stop; workers include subagent (same-model inheritance) but NOT handyman itself |
| `session_rebuild` | trajectory tracker | full surface reset on context overrun (Ship of Theseus): replace → first-anchor protocol text + continue instruction → auto-resume |
| `localstore` | credential store | credential/config namespaces with configurable git policy |

### Interception seams

| Seam | Capability |
|------|-----------|
| `tools/pre-execute` | safe-mode bash deny / governance-file protection / blacklist / path escape → deny |
| `ctx.tools.guard` | terminal deny (order-independent invariant) |
| `tools/restrict` | bash disappears from the model tool list in safe-mode (synced each step) |
| `agent/session-start` + `agent/pre-step` | ACC injection + safe-mode restrict per step |
| `systemPrompt.section` | full 8-block system prompt (global, order -50) |
| `agent/inbox/inserted` | first-anchor injection (2 protocol messages on first turn) |
| `agent/turn-stopping` | session_rebuild execution point (turn-end wipe + steer auto-resume) |
| `session/event` (compaction/end) | retention: re-inject ACC identity after compaction |
| `tools/post-execute` | Trajectory Steward DCP (scoring reminder) + trajectory tracker contextPressure check (independent mechanisms) |

### session_rebuild (trajectory tracker) + Trajectory Steward

```
Steward post-execute: contextPressure projection ≥ rebuildThreshold → append [TRAJECTORY] hint
  → LLM actively calls session_rebuild (never automatic — prevents accidental wipes)
  → queueRebuild: gate + build anchor → pending queue
  → agent/turn-stopping: surface replace all nodes → anchor message
    ([TRAJECTORY-REBUILD] + first-anchor protocol text + "continue S###" + SESSION.md path)
  → agent.steer(auto-resume) → next-step non-empty → turn does not break → model reads SESSION.md
```

- **SESSION.md = persistent trajectory** (identity/decisions/progress, always in place); **dsh session = temporary rebuildable working copy** — the carrier is rebuildable, the trajectory is continuous (Ship of Theseus)
- Same session id rebuilt in place → same workspace naturally, no destroy/switch/archive
- **Shadow-price protocol compliant (v1.23.5)**: a `compaction/prune` metering event precedes the replace, pricing the replaced range → token-meter accounting resets correctly (the UI "conversation messages" figure no longer drifts upward)
- Threshold configurable in the DSH settings panel (rebuildThreshold, default 0.9)

**Trajectory Steward** (named in v1.23.0): a scoring-reminder mechanism — when tool use crosses a threshold it reminds the agent, with a `[TRAJECTORY-STEWARD]` prefix + ACK protocol, to record progress back into SESSION.md; the mechanism is pre-declared in the Session block of the system prompt (mechanism before reminder).

### Dual-port gateway (external access)

```
External browser → http://LAN-IP:3081 (second listener, plugin-owned)
  → not logged in → minimal login page (username + password OR 6-digit code, either works; mobile-adapted)
  → POST /serenity/login: scrypt OR TOTP (independent of password — either passes)
      + CSRF double-submit (server-side token store, multi-tab safe) + lockout (5 → 15min exp. backoff)
  → HttpOnly cookie (SameSite=Strict, sliding 24h) → 302 reverse proxy
  → logged in → proxy 127.0.0.1:main-port (Host/Origin rewritten to loopback, passes trust fence)
  → /api/workspace.list allowlist filtering + workspace.create validation
  → WS upgrade forwarding (101 write-back + bidirectional error listeners)
```

- Accounts/passwords/TOTP/allowlist = **plugin-global config** (`~/.dsh/serenity-hooks.json`, 0600) — plugin is global, CCC is concrete
- Switch (gatewayEnabled) in the DSH settings panel; account CRUD in the panel's "External Access" section
- **Either-or credentials (v1.24.6)**: an account with a bound authenticator logs in with the password OR a 6-digit code (unbound: password only; totpEnabled off: TOTP fully disabled)
- **QR-code TOTP binding (v1.24.6~7)**: bind an authenticator → random secret + rendered QR → scan with Authenticator → save to bind (no confirmation code)
- Security audit (S1-S12): scrypt + timing-safe + 256-bit token + CSRF token store + TOTP + lockout + audit logs

### Activation gating

Everything activates only inside a CCC directory marked with `.serenity`; zero effect on DSH behavior elsewhere (guards/injection/persistence pass through; tools degrade with errors).

### Config layers

| Config | Location | Contents |
|--------|----------|----------|
| DSH settings panel | settings.yaml (native DSH) | gatewayEnabled / rebuildEnabled / rebuildThreshold / namingEnabled |
| Plugin-global file | `~/.dsh/serenity-hooks.json` (0600) | gateway accounts (scrypt + TOTP) / host / port / workspaces allowlist / cookieSecure |
| CCC config | `.opencode/serenity.json` | handyman.models (whitelist + default model) / sessionKeeper.threshold / safeMode.blacklist / hooks.autoRestoreSession |
| CCC credentials | `localstore.json` | credential/config namespaces (configurable git policy) |

## System prompt (aligned with opencode-serenity-plugin)

Eight blocks in the same order (ACC → Metaphor → Principles → CCE → EAP → state → SKILL full text → Session); platform-neutral text is **byte-identical** (mechanically asserted in `hooks/dsh-serenity-hooks/tests/osp-alignment.test.ts`). The only platform differences are tool names (DSH's real tools) and governance-content filtering in the SKILL block. Since v1.23.0 all model-visible text is English (Session-as-carrier definition + Trajectory Steward pre-declaration follow specs v1.3.1).

## WebUI

- **Session-header status capsule** (`conversation.session.header.actions` slot): **capsule** (v1.24.10, aligned with the OcgoDockEntry pill) — 999px full-round + translucent bg-layer-2 background; 7px always-green dot (= Serenity online, independent of SAFE) + `Serenity vX.Y.Z` (monospace, sink-aligned) + 1px divider + shield SAFE (ON = emerald gradient `#0ba875→#059669` / OFF = gray) + **Mac-style quick-toggle slider** (24×13 track + 11px gray-white icon-less thumb + cubic-bezier easing); clicking the card opens a **self-drawn popover** (340px top-right card, outside-click/Escape closes: root path / handyman model / guard info / safe-mode big toggle / runtime state); ships with the Windows compatibility patch set (v1.24.10: bun detection / registry protection / path-traversal defense, 8 files)
- **DSH settings section** (`settings.section` slot): Serenity page — 3 feature switches + threshold + "External Access" block (listen address/port + account CRUD + QR-code TOTP binding + workspace allowlist chips + Secure Cookie)
- **Image auto-fallback** (`conversation.input.dock` slot): silent recovery when the model rejects images (upload + clear rail + resend as text)
- **Any-file auto-save** (`conversation.input.dock` slot): pasting a non-image file → auto-saved to `_tmp/files_from_user/` + draft path note (sent with the message)
- Styling follows [web-styling.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/web-styling.md): `--dsw-alias-*` semantic tokens, light/dark adaptive

## Development

```bash
pnpm typecheck   # hooks/dsh-serenity-hooks (node + client)
pnpm test        # vitest full suite (42 files / 465 tests)
pnpm build       # tsc + tsdown dual bundle (lib/index.js + client.js)
```

Typecheck runs against real DSH type contracts (tsconfig paths point at a local DSH install, see `hooks/dsh-serenity-hooks/tsconfig.json`).

- **Dev MSMs**: `scripts/dsh-develop.ts` (typecheck/test/build/status/commit/push/version/bump/deploy/restart-web/publish/github-push/**npm-install-dev**) + `scripts/dsh-crash-investigate.ts` (crash investigation, read-only)
- **Code map**: `docs/codebase-overview-v1.22.md` (layers / module map / data flows / config layers / entropy points)

## Relationship to opencode-serenity-plugin

| | opencode-serenity-plugin | dsh-serenity-plugin |
|---|------|------|
| Host | OpenCode | DeepSeek Harness |
| Implementation | independent | **independent** (no source reuse) |
| System prompt | `system.transform` | `systemPrompt.section`, byte-aligned on platform-neutral text |
| Tools | msm_list/exec/cc-fs/session etc. | cc_fs/session/acc_msm/cc_git/eap/neat/cce/handyman/session_rebuild/localstore |

## Interchangeable CCC runtime (osp or dsh)

**A CCC is decoupled from its runtime plugin — any CCC can switch between opencode-serenity-plugin and dsh-serenity-plugin as its ACC runtime:**

- **CCC file formats are runtime-independent**: the `.serenity` marker (content = top-level entry skill name), `.opencode/skills/` (knowledge skills), `.dsh/serenity.json` (config), `AGENT_SESSIONS/` (session tracking) — both plugins read and write the same files with the same semantics.
- **Choose either**: install opencode-serenity-plugin on an OpenCode host, or this plugin on a DSH host; the same CCC can switch runtimes at any time without touching skills or existing data.
- **Differences are platform-only**: tool naming (`msm_exec`/`cc-fs` vs `acc_msm`/`cc_fs`) and the system-prompt injection channel (`system.transform` vs `systemPrompt.section`) — platform-neutral text is byte-aligned, so the agent receives identical cognitive constraints after switching.

## License

MIT — see [LICENSE](LICENSE)

> **Version**: v1.24.9 &nbsp;|&nbsp; **Prereqs**: DSH 0.1.0-rc+ / Node ≥ 20 / bun
