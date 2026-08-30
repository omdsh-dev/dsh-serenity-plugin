# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **Cognitive-container infrastructure for DeepSeek Harness (DSH).** Any directory marked with `.serenity` (a CCC, Concrete Cognitive Container) automatically gains: 12 ACC tools, mechanical safety constraints, session-trajectory tracking, and external access & Q&A capabilities — **one plugin, one cognitive workspace**.
>
> Targets [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc and later.
> Theory (what a cognitive container is): [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) — this README covers capabilities and usage.

---

## Quick start (2 minutes)

Prerequisites: Node ≥ 20 (or bun), DSH 0.1.0-rc or later.

```bash
# 1. Install the plugin from npm registry (auto-joins the DSH profile's bundles layer)
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. Restart dsh web (plugin + WebUI client take effect)
dsh web

# 3. Verify: open a session inside a directory marked with .serenity (a CCC)
#    · Session auto-injects ACC identity + entry-skill system prompt
#    · WebUI session header shows the Serenity status capsule (green dot + SAFE shield slider)
#    · Run acc_kit health → CCC three-principle check passes
```

Uninstall: `dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

> **Local dev install** (from source): `git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git && cd dsh-serenity-plugin && dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks`
> ⚠️ A git-URL install (`github:...`) points at the repo root package (a workspace container, not a bundles-layer plugin) and will not activate — use link or npm.

**Enable safe mode**: toggle the SAFE slider on the WebUI capsule → **bash disappears from the model's tool list** (not an error — the model simply cannot see it) → the agent can only use registered, tested MSM channels. The switch is a user capability; the agent cannot see or toggle it.

---

## What you get after install (capability map)

### 12 ACC tools

| Tool | Capability | Typical use |
|------|-----------|-------------|
| `cc_fs` | 15 filesystem subcommands (root/resolve/list/tree/mkdir/rm/mv/cp/touch/append/reveal/info/find…) | Paths confined to the CCC root; escape is auto-blocked |
| `session` | Full session lifecycle (list/show/create/use/close/health/qa/archive/summary) | `session create` before multi-step work; `use` to resume |
| `acc_kit` | Health check (CCC principles P1/P2/config) / time / wait | Routine self-check before entering a CCC |
| `cc_git` | Git operations (status/commit/push/log/pull) | Non-fast-forward pushes suggest actions; never auto-force |
| `acc_msm` | MSM framework (list/exec/register/deregister/check/guide/ccc-config) | Executable-unit registry + 600s-timeout safe execution |
| `eap` / `neat` / `cce` | Cognitive-quality framework / design-collaboration protocol / continuity engineering (progressive disclosure) | Output self-check, design alignment, engineering review |
| `handyman` | Worker loop: whitelisted-model worker runs synchronously to completion + parallel `jobs` orchestration | Delegating batch work (e.g., SQC scans) |
| `session_rebuild` | Trajectory rebuild on context overflow (Ship of Theseus) | Prompted past threshold; LLM triggers rebuild to continue |
| `localstore` | Credential/config storage (credential + config namespaces) | Central API-key/password management; git policy configurable |
| `skiff_admin` | Skiff role management (guide/validate/apply/list) | Define/validate/apply cognitive-subset roles |

### Mechanical constraints (not bypassable by the model)

| Constraint | Mechanism |
|-----------|-----------|
| **Safe mode** | bash disappears from the tool list (`tools.restrict`, synced each step) + guard fallback deny |
| **Path boundary** | P3 binary permission: full inside CCC root, zero outside (path-escape blocking) |
| **Blacklist/governance files** | Configurable blacklist + `.serenity` governance-file write protection |
| **Credential-file guard** | `localstore.json` is denied to every tool (incl. read/grep/glob) — credential values structurally cannot leak |
| **Output guard** | External faces (skiff/acp/rebuild sessions) scan final output for sensitive terms → steer-back regeneration (lists hit terms + category guidance) |
| **Trajectory reminders** | Trajectory Steward scoring + context-pressure detection pushes progress back into SESSION.md |

### External faces (services)

| Face | Port | Purpose |
|------|------|---------|
| **Dual-port gateway** | 3081 (default 0.0.0.0) | Full WebUI after login (password OR TOTP + workspace whitelist) |
| **Skiff debug Q&A page** | 3099 (default 127.0.0.1) | Cognitive-subset role debugging (multi-CCC switching + trajectory rendering) |
| **ACP + public ask page** | 3100 (default 127.0.0.1) | ACP JSON-RPC programmatic access + public Q&A page (key auth + container whitelist; Q&A only — no internal trajectory) |
| **Public access** | Cloudflare Tunnel | Expose to the internet via tunnel (dsh / asktest entries) |

---

## Usage scenarios (real capabilities)

> Based on the real deployment "Serenity" (all addresses/accounts/paths/keys are generalized). One directory marked with `.serenity` = one CCC.

### Anatomy of a CCC

```
home-serenity/                    ← CCC root (marked by the .serenity file)
├── .serenity                     ← marker: this directory is a cognitive container
├── .opencode/
│   ├── serenity.json             ← CCC-level config: handyman model whitelist / thresholds / skiff roles
│   └── skills/                   ← domain skills (each = an EAP-encapsulated body of knowledge)
│       ├── home-media/           ←   media: acquisition / subtitles / distribution
│       ├── home-wealth/          ←   finance: assets / liabilities / budget
│       ├── family-profiles/      ←   member profiles (single source of truth)
│       └── … (each skill may hold MSM scripts)
├── AGENT_SESSIONS/               ← session repository: one SESSION.md per directory (persistent trajectory)
│   └── 2026-08-29--S142--xxx/
│       └── SESSION.md            ← trajectory body: goals / decisions / progress (never moves)
└── _tmp/                         ← runtime drops (images / pasted files)
    ├── images_from_user/
    └── files_from_user/
```

### Daily capabilities (10 real use cases with operation chains)

| # | Scenario | Operation chain (tool → subcommand → effect) |
|---|----------|----------------------------------------------|
| 1 | **Long-term project maintenance** | `session create --desc xxx` → auto SESSION.md → log progress step by step → `session use` to resume → `session_rebuild` on context overflow |
| 2 | **Batch code sync** | Root repo `cc_git commit/push`; multiple sub-repos one-click `resources-management sync` (auto commit + push all) |
| 3 | **Media subtitle production** | Find source (BT) → download → Whisper transcription → translation → bilingual SRT → mechanical QC (7 checks) → distribution (RSS/email) |
| 4 | **Server inspection** | `server-tool health` → one-shot CPU/memory/GPU/container/service report; `server-tool container` view/restart — all via the ssh-connect whitelist channel |
| 5 | **Intranet service lookup** | `landscape-tool` repo panorama (20+ repos: category/stack/relations); `network-tool` device/port scan |
| 6 | **Finance data management** | Local structured records (assets/liabilities/income/expense/budget) → query/summary; macro tracking (e.g., mortgage-rate comparison) |
| 7 | **Member profiles** | `profile list/show/create/update` — unified member data; the CCC is the single source of truth |
| 8 | **Thought capture** | Chat whenever an idea arises → AI interview-style clarification → structured archive → periodic pattern review |
| 9 | **External access (phone/travel)** | Browser → `http://LAN-IP:3081` → login (username + password OR 6-digit Authenticator code) → operate the WebUI from a phone |
| 10 | **Pasted-content auto-processing** | **Images**: paste → auto drop → vision-model recognition (receipts/screenshots/charts); **any file**: paste PDF/archive → auto drop → agent extraction (PDF/unzip/spreadsheet, dedicated MSMs) |

### A typical day

```
Morning:  intranet service inspection (server-tool health) → all good
Midday:   sync yesterday's code (resources-management sync) → all sub-repos pushed
Lunch:    receive a PDF bill → paste into chat → auto drop + table extraction → record into finance
Afternoon: produce a video's subtitles (Whisper → translate → bilingual SRT → QC) → push to subscribers
Evening:  external device accesses home services (3081 login: TOTP verification) → handle an ops issue
All day:  every piece of work lands in SESSION.md → trajectory continuous, switchable across people/models/hosts
```

---

## External access & security

### Dual-port gateway (3081)

```
External browser → http://LAN-IP:3081 (second listener started by the plugin)
  → not logged in → minimal login page (username + password OR 6-digit code; mobile-adapted)
  → POST /serenity/login: scrypt verify / TOTP check + CSRF token set + fail-lock (5 → 15min exp. backoff)
  → HttpOnly cookie (SameSite=Strict, sliding 24h) → 302 proxy
  → logged in → proxy to 127.0.0.1:main-port (Host/Origin rewritten to pass the trust fence)
  → /api/workspace.list whitelist filtering + workspace.create validation
  → WS upgrade forwarding (101 write-back + bidirectional error listeners prevent crashes)
```

### Skiff cognitive-subset roles (3099 + skiff_admin)

A CCC carves out **any subset of its full-knowledge trajectory** (`.opencode/serenity.json skiff.roles`) — not limited to Q&A; may have operational capability:

```jsonc
{
  "skiff": {
    "roles": {
      "qa": {
        "model": "provider/model",              // per-role model
        "msms": ["web-search", "vlm-describe"], // independent MSM whitelist
        "tools": ["read", "grep", "glob"],      // independent non-MSM tool whitelist
        "systemPromptFile": "roles/qa.md"       // or inline systemPrompt
      }
    }
  }
}
```

- **Dual whitelists**: MSM and non-MSM tools configured independently; everything outside is hidden; skill loading always available
- Debug Q&A page (3099) with multi-CCC switching; answers rendered with marked + think folding
- `skiff_admin validate` checks config → `apply` activates explicitly (binds CCC + role list)

### Public ask page (3100 + internet)

- **Key auth** (timing-safe + per-IP fail-lock + rotatable key) + container whitelist (empty = all open)
- **Q&A only**: response contains answer/answer_html/sessionId — **no internal trajectory**
- Expose to the internet via Cloudflare Tunnel (no DSH config change)

### Security model

| Layer | Mechanism |
|-------|-----------|
| Login | scrypt password hash + constant-time compare + 256-bit token + sliding 24h TTL + audit log |
| 2FA | TOTP (RFC 6238, Authenticator-compatible) QR-code binding; password OR code either way |
| Anti-brute-force | Per-account fail-lock (5 → 15min exp. backoff) |
| Anti-CSRF | Login double-submit + config PUT Origin check + server-side token set (multi-tab safe) |
| Credentials | `localstore.json` centralized (git refuses commits by default); data-plane guard isolates structurally |
| Output | External-face output guard: sensitive-term detection → steer-back regeneration (lists terms + category guidance) |

---

## Configuration (4 layers)

| Layer | Location | Contents |
|-------|----------|----------|
| DSH settings panel | settings.yaml (DSH native) | Feature toggles (gateway/rebuild/naming) + rebuild threshold + skiffEnabled/skiffDebugPort + acpEnabled/acpHttpPort + publicAskEnabled |
| Plugin global file | `~/.dsh/serenity-hooks.json` (0600) | Gateway accounts (scrypt + TOTP) / host / port / workspace whitelist / cookieSecure / publicAsk key |
| CCC config | `.opencode/serenity.json` | handyman.models (whitelist + default model) / sessionKeeper.threshold / safeMode.blacklist / skiff.roles |
| CCC credentials | `localstore.json` | Credential/config namespaces (git policy configurable) |

> Principle: **the plugin is global, the CCC is concrete** — accounts/toggles/thresholds belong to the plugin layer; roles/credentials/local preferences belong to the CCC.

---

## Context & trajectory management

| Mechanism | Description |
|-----------|-------------|
| **SESSION.md** | The trajectory's persistent body, never moves; multi-step goals/decisions/progress live here |
| **session_rebuild** | Context over threshold → `[TRAJECTORY]` prompt → LLM triggers → same-session surface wipe (anchor keeps protocol text + "continue S###") → auto-resumes; shadow-price protocol compliant (token accounting resets correctly) |
| **Trajectory Steward** | Scoring reminders (`[TRAJECTORY-STEWARD]` + ACK protocol) push progress back into SESSION.md; mechanism pre-declared in the system prompt |
| **Cognitive sedimentation discipline** | Before rebuilding, if valuable cognition was produced → revise the relevant skill (EAP-structured); for new skills, write a proposal into SESSION.md for user review — never create them yourself |

---

## Theory (index)

- **Condensed narrative**: [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) — what a cognitive container is / the cognitive Loop (actions = feedback) / Trajectory as subject / Session = rebuildable carrier / cognitive closure
- **Authoritative standard**: [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) (§0 theoretical foundation + injection spec + invariants)

---

## Development & extension (plugin-author view)

```bash
# Full dev loop (also via acc_msm exec dsh-develop under safe mode)
pnpm typecheck          # hooks/dsh-serenity-hooks (node + client)
pnpm test               # vitest full (50 files / 648 tests)
pnpm build              # tsc + tsdown dual bundle (lib/index.js + client.js)
```

- **Dev MSMs**: `scripts/dsh-develop.ts` (typecheck/test/build/status/commit/push/version/bump/deploy/restart-web/publish/github-push/npm-install-dev) + `scripts/dsh-crash-investigate.ts` (crash investigation, read-only)
- **Architecture**: Native Cordis plugin (real DSH tools via `ctx.tools.register` + interception seams `systemPrompt.section`/`tools/pre-execute`/`agent/turn-stopping`…); **zero DSH harness changes** — everything uses plugin seams/events/injected services
- **Code map**: `docs/codebase-overview-v1.22.md` (layered architecture / module responsibilities / data flows / config layers)
- **Design decisions**: D1–D30+ in CHANGELOG.md and the maintenance skill (`dsh-serenity-plugin-development`)
- **Release**: npm `@shgroup/dsh-serenity-hooks` + GitHub dual remotes (tellmewhattodo + omdsh-dev)

## Relation to opencode-serenity-plugin / CCC interchangeability

| | opencode-serenity-plugin | dsh-serenity-plugin (this repo) |
|---|------|------|
| Host | OpenCode | DeepSeek Harness |
| Implementation | Independent | **Independent** (no source reuse; same ACC standard) |
| System prompt | `system.transform` | `systemPrompt.section`, byte-aligned on platform-neutral text |
| Tools | msm_list/exec/cc-fs/session etc. | cc_fs/session/acc_msm/cc_git/eap/neat/cce/handyman/session_rebuild/localstore/skiff_admin |

**The same CCC can switch between osp / dsh runtimes freely**: `.serenity` marker, `.opencode/skills/`, config, and `AGENT_SESSIONS/` share cross-runtime file formats; only the platform layer differs (tool names/injection channel); the cognitive constraints the agent receives are identical after switching.

## FAQ

**Q: Nothing happens after install?** Make sure you entered a `.serenity`-marked directory (a CCC); outside CCCs the plugin does nothing. Run `acc_kit health` to verify the three principles.

**Q: Where did bash go?** Safe mode removes bash from the tool list — by design: registered, tested MSM channels are more reliable. Turn it off with the WebUI capsule slider.

**Q: Locked out of external access (3081)?** 5 failed attempts lock for 15 minutes (exponential backoff) — wait it out, or check the account's TOTP binding.

**Q: Context is nearly full?** Land your progress into SESSION.md, then call `session_rebuild` per the `[TRAJECTORY]` prompt — the trajectory continues automatically; no need to open a new session by hand.

**Q: What does the public Q&A page (3100) return?** Only the answer (answer/answer_html/sessionId) — internal trajectories, tool results, and mechanism information never leave the external face.

## License

MIT (see [LICENSE](LICENSE))

> **Version**: v1.26.11 &nbsp;|&nbsp; **Prereq**: DSH 0.1.0-rc+ / Node ≥ 20 / bun &nbsp;|&nbsp; **Tests**: 50 files / 648 tests
