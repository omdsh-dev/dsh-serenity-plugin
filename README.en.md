# Serenity ACC — an "AI workspace" for DeepSeek Harness

> **In one line**: install this plugin and you carve out a workspace for your AI — just an ordinary directory. Inside it, the AI gains **memory, discipline, tools, and boundaries**, so it can pick up the work after a model switch, a reboot, or a night's sleep.
>
> Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 0.1.2-rc.1 or later.
> For the thinking behind it (why "cognitive container"), see [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md). This README covers **what it does and how to use it**.

**Four words, explained once** (used throughout, not repeated):

| Term | Plain meaning |
|---|---|
| **Workspace / CCC** | A directory containing an empty `.serenity` marker file. Elsewhere, the plugin does nothing at all; the moment you open a session inside such a directory, it activates |
| **Plugin / ACC** | This repository (npm package `@shgroup/dsh-serenity-hooks`). It adds tools, constraints, and memory to DSH |
| **MSM** | A small executable tool you write inside the workspace (one script + one registry line). The AI calls it with `msm("name", ["args"])` |
| **SESSION.md** | The workspace's work log. The AI writes goals, decisions, and progress there, so an interrupted task can resume from it |

---

## 1. What problem it solves

No theory — four everyday annoyances:

| Annoyance | Without it | With it |
|---|---|---|
| **The AI forgets what it was doing** | Context fills up, goals and decisions are gone, you re-explain everything | Every workspace keeps a work log the AI updates as it goes. When context fills up, it swaps the carrier and continues — the log never moves |
| **The AI rummages and edits files everywhere** | It can read your whole machine, keys included | The workspace has walls: everything inside is fair game, everything outside is refused — secret files cannot even be read |
| **You want to use it away from the desk** | You must sit at that machine | It ships a login-protected web entry (password or phone code), so your phone works too |
| **Your family wants to ask it things over WeChat** | You'd have to teach them to install software and boot a computer | Scan a QR code once, and they simply message it on WeChat; it answers in the persona you defined |

---

## 2. Quick start (2 minutes)

Prerequisites: Node ≥ 20 (or bun), DSH 0.1.2-rc.1 or later.

```bash
# 1. Install the plugin (joins the DSH web profile automatically)
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. Restart dsh web (plugin and web client both take effect)
dsh web

# 3. Verify: open a session inside a directory marked with .serenity
#    · The session starts with this plugin's identity note and skill catalog
#    · A status capsule appears next to the session title (green dot + SAFE slider)
#    · Run dashboard health — the three workspace checks should all pass
```

Uninstall: `dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

Install from source (when you are changing the code):

```bash
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks
```

> ⚠️ Do **not** use `dsh plugin add github:...` — that URL points at the repository root package (a workspace container, not the plugin itself) and will not activate. Use npm or the `link:` form above.

**Safe mode**: flip the SAFE slider on the web capsule and `bash` **disappears from the AI's tool list** (not an error — the model simply cannot see it). From then on the AI can only use the small tools you registered and tested. The switch is yours: the AI cannot see it or flip it.

---

## 3. What you get after installing

### 3.1 The eleven tools

| Tool | What it does | When to use it |
|---|---|---|
| `container_fs` | File handling inside the workspace: list, find, copy, move, create, append, reveal in file manager | Whenever you need to look at or tidy workspace files |
| `logbook` | The whole life of a work log: create, show, switch, close, archive — plus in-place rebuild | Any multi-step job; this is step one |
| `dashboard` | Instruments: workspace health (three checks), current time, wait | Self-check before working; wait on external services |
| `container_git` | Git: status / commit / push / log / pull / diff | Commit and push; it never force-pushes on its own |
| `msm` | The execution entry for your small tools: `msm("name", ["args"])`; partial names return candidates; `inspect=true` shows usage | Calling any registered tool in the workspace |
| `praxis` | Injects one of three "ways of working" on demand: output self-check (eap), design alignment (neat), cognitive continuity (cce) | When you want it to be precise, or to align before building |
| `handyman` | A cheap worker model runs in rounds until done; several can run in parallel | Bulk, repetitive work (e.g. scanning dozens of skills) |
| `localstore` | Stores secrets and settings (credential and config namespaces) | Keep API keys and passwords in one place, out of git |
| `container_admin` | The maintenance bay: manage sub-roles, manage the tool registry, view all configuration | Defining a sub-role, registering a new small tool |
| `autopilot-trajectory` | Autonomous cruising: wake a workspace on a clock and inject its current focus; several workspaces stay independent | When you want the AI to work on its own on a schedule (see §6.5) |
| `im-bridge` | Message an IM contact (WeChat today): send text, send a file, list configured recipients, check channel health. Every successful send is recorded in the workspace log | When you want the AI to message family/colleagues proactively (see §6.6). **It only appears when this workspace has the WeChat bridge configured**, and it can only message from this workspace |

> **Renamed** (old names are gone for good, no aliases): `cc_fs` → `container_fs` · `cc_git` → `container_git` · `session`+`session_rebuild` → `logbook` · `acc_kit` → `dashboard` · `acc_msm` → `msm` (execution) + `container_admin` (management) · `eap`/`neat`/`cce` → `praxis` · `skiff_admin` → `container_admin role`. Old sessions referencing the old names will error — consult this map.

### 3.2 Mechanical constraints (the AI cannot bypass them)

These are not "please don't" hints in a prompt — they are **mechanically impossible**:

| Constraint | What you will see | Why it is built this way |
|---|---|---|
| **Safe mode** | bash vanishes from the tool list (synced every step); even an attempted call is denied as a fallback | Going through registered, tested tools beats letting the AI assemble shell commands |
| **Workspace walls** | Everything inside works, everything outside is refused (the path never even resolves) | The AI should not touch anything outside its workspace |
| **Blocklist / governance files** | A configurable blocklist; `.serenity` and similar governance files cannot be written | So the AI cannot damage the foundation it stands on |
| **Secret-file guard** | `localstore.json` is denied to **every** tool (read/grep/glob included) | Secret values are structurally unable to leave |
| **Outbound output guard** | On outward-facing sessions (sub-role / ACP / rebuilt sessions), sensitive wording is rejected and regenerated, with the hit word and guidance reported | Outsiders should not see internal mechanics |
| **Trajectory reminders** | After long stretches it reminds the AI to write progress back to the log and expects a confirmation code | The reminder is a mechanism, not a hope |
| **Logbook size reminder** | When the work log (SESSION.md) passes 100KB it tells the AI to stop and rewrite it, with four rewrite principles (keep the skeleton / move detail into attached files / merge what no longer matters / the rest is your call) | A log nobody can finish reading is worse than a shorter one; rewriting beats piling up. The limit is per workspace (`sessionKeeper.sessionMdMaxKB`, 0 = off) |
| **Handover before rebuild** | Before rebuilding context it asks the AI to write "where I am / what is unfinished / the next action" at the very **end** of the work log under a fixed heading; the rebuilt self reads that section first and continues | The context is discarded, but the in-flight work must not be — write and read sides share one heading, so the section can be found |

### 3.3 Entry points

| Entry point | Default port | Who uses it |
|---|---|---|
| DSH main UI | 3080 | You, locally (the plugin never touches this port) |
| **Web login entry** | 3081 | Remote/phone access to the full UI: reverse-proxies to 3080 after login; workspace allow-list supported |
| **WeChat proactive send** | 3082 (127.0.0.1 only) | Scripts/integrations *outside* the workspace use it to message WeChat users (not reachable from the internet, so no key is needed). The AI inside a workspace does not use this port — it calls the `im-bridge` tool directly |
| **Sub-role debug page** | 3099 (127.0.0.1 only) | Debugging "sub-roles"; switch workspaces and inspect the conversation |
| **ACP + public Q&A page** | 3100 (127.0.0.1 only) | Programmatic access (JSON-RPC) + a Q&A page for others (key auth; answers only, no internal trajectory) |
| **WeChat bridge** | no port (outbound long-poll) | Your family talking to the AI directly in WeChat |

> Entry points that default to 127.0.0.1 are yours to expose (tunnel, reverse proxy, port mapping — your call). The plugin does not prescribe any particular method.

---

## 4. What a workspace looks like

A workspace is an ordinary directory plus one marker file:

```
my-workspace/                     ← workspace root (just add .serenity)
├── .serenity                     ← marker: this directory is a workspace
├── .opencode/
│   ├── serenity.json             ← workspace-level config: worker model allow-list / log threshold / sub-roles
│   └── skills/                   ← domain skills (each = one domain's knowledge, possibly with small tools)
│       ├── home-media/           ←   e.g. media (find sources / subtitles / delivery)
│       ├── home-wealth/          ←   e.g. household finance
│       └── … (each skill may ship scripts)
├── AGENT_SESSIONS/               ← work-log archive: one SESSION.md per directory
│   └── 2026-09-08--S142--xxx/
│       └── SESSION.md            ← goals / decisions / progress (stays here forever)
└── _tmp/                         ← runtime files: images and files you paste
    ├── images_from_user/
    └── files_from_user/
```

---

## 5. What you can do with it (12 real use cases)

> All of these run in a real deployment. Addresses, accounts, and paths are generalized.

| # | What you want | How it actually goes |
|---|---|---|
| 1 | **Keep a long project alive** | `logbook create` → write progress as you go → resume with `logbook use` after an interruption → `logbook rebuild` when context fills up, continuing automatically |
| 2 | **Sync code in bulk** | `container_git commit/push` in the current repo; one command syncs every sub-repo (auto commit + push) |
| 3 | **Produce one episode of subtitles** | Find the source → download → Whisper transcription → translation → bilingual SRT → mechanical QC (7 checks) → push to subscribers/email |
| 4 | **Server inspection** | One command returns CPU/memory/GPU/containers/services; restarting a container goes through the same allow-listed channel |
| 5 | **Locating internal services** | Repository overview (categories/stack/links) + device and port scanning |
| 6 | **Household finance** | Structured records for assets/liabilities/income/expenses/budgets, queryable anytime; mortgage-rate comparisons and similar macro tracking |
| 7 | **Family profiles** | One maintained source of truth for each member's data |
| 8 | **Jotting down ideas** | Say what's on your mind, the AI interviews you to structure it, and periodically reviews your thinking patterns |
| 9 | **Phone / remote use** | Open `http://LAN-IP:3081` → password or a 6-digit code → full UI on your phone |
| 10 | **Paste and let it process** | Paste an image → saved automatically → vision model reads it (delivery slips, screenshots, charts); paste a PDF/archive → saved → extract text, unpack, read tables |
| 11 | **Use the AI in WeChat** | Scan once from the settings panel → family members send text/voice/images/files → routed to a chosen sub-role → the reply lands back in WeChat |
| 12 | **Let it work on a schedule** | Configure cruising (interval / target session / focus / bias script) → it wakes on time with its focus injected, in front of you, interruptible at any moment |

**A typical day**:

```
Morning   server inspection (one command) → all clear
Midday    sync yesterday's code → every sub-repo pushed
Lunch     a PDF bill arrives → paste into the chat → saved + tables extracted → recorded in finance
Afternoon produce an episode's subtitles (transcribe → translate → bilingual SRT → QC) → push to subscribers
Evening   log in to 3081 from the phone to handle an ops issue (code verification)
All day   every stretch of work lands in SESSION.md → the trajectory stays continuous, ready for another person, model, or machine to pick up
```

---

## 6. Entry points in detail

### 6.1 Web login entry (3081)

The plugin starts its own second listener. A request flows like this:

```
external browser → http://LAN-IP:3081
  → not logged in → minimal login page (username + password, or a 6-digit code — either one; mobile-friendly)
  → submit → scrypt verification / TOTP check + CSRF check + lockout after repeated failures (5 tries → 15-minute exponential backoff)
  → pass → HttpOnly cookie (SameSite=Strict, 24-hour sliding expiry) → 302 redirect
  → logged in → reverse-proxy to 127.0.0.1:3080 (Host/Origin rewritten as a trust fence)
  → workspace list filtered by allow-list + workspace creation validated
  → WebSocket upgrades forwarded too (101 rewrite + two-way error listeners so a socket cannot take the process down)
```

### 6.2 WeChat bridge

Configured per workspace (the `weixin` section of `.opencode/serenity.json`), with **credentials in the workspace's `localstore.json`** (never plain text in git).
One DSH process can host several workspaces, each bridging its own WeChat account.

- **Scan to bind**: settings panel → WeChat bridge → pick a workspace → scan (confirm in the phone's WeChat) → the bot token is stored as a credential
- **Multiple accounts**: each account binds and unbinds independently
- **What it receives**: text, voice (WeChat transcribes server-side — no extra speech model needed), images, files
  (images and files are downloaded from WeChat's CDN and decrypted into `_tmp/weixin-inbound/`, then the path is handed to the AI)
- **Typing indicator**: WeChat shows "typing…" while the AI works
- **Clean replies**: the thinking process is stripped; WeChat sees only the final text
- **It remembers**: one WeChat user maps to a fixed session that survives restarts — no amnesia
- **Routing**: WeChat user → sub-role (exact match first, `*` as fallback)
- **Proactive messages** (v1.31.0): the AI sends them itself with the `im-bridge` tool —
  `im-bridge({channel:"weixin", action:"send", user:"yh", text:"text"})`
  (files: `action:"send-file"` + `file:"<path inside the workspace>"`, optional `caption`).
  The tool **can only message from this workspace** (there is no "target workspace" parameter, so it cannot
  message the wrong container), and every send is recorded automatically. It **only appears in the tool list
  when this workspace has the WeChat bridge configured** — otherwise it is hidden entirely, not "visible but failing".
  (The old approach — a workspace script talking to port 3082 — is retired as of v1.31.0; 3082 stays for scripts outside the workspace.)
- **Let the AI decide how to reply** (v1.30.10): with `"weixin": { "autoReplyWithLastMessage": false }`
  the plugin no longer forwards the AI's final message; instead it tells the AI every turn "you must send it yourself"
  and hands it a ready-to-copy `im-bridge` call. Suits roles that report progress, split messages, or stay silent when
  silence is right. Defaults to `true` (previous behaviour).
  If the AI still fails to send, the plugin **nudges it back** (up to 2 times); you can additionally set
  `"fallbackOnNoSend": true` so the plugin forwards that turn's text itself (recorded as `source: "reply-fallback"`)
  and no message is lost.
- **Message recording**: point `weixin.hook` at a script and every incoming/outgoing message is handed to it as JSON;
  where you store it is up to you. In the record, `source: "reply"` means "answering a user", `source: "proactive"` means
  "the AI initiated it", and `source: "reply-fallback"` means "the AI did not send, the plugin did".
- **Troubleshooting**: `msm("weixin-doctor", ["status"|"diag"|"verify"|"guide"])`

### 6.3 Sub-roles (Skiff)

Carve a **deliberately limited role** out of an all-capable assistant — not just Q&A, it can also have operational abilities:

```jsonc
{
  "skiff": {
    "roles": {
      "qa": {
        "model": "provider/model",              // this role's own model
        "msms": ["web-search", "vlm-describe"], // which small tools it may call
        "tools": ["read", "grep", "glob"],      // which platform tools it may use
        "systemPromptFile": "roles/qa.md"       // its persona and boundaries (inline is also fine)
      }
    }
  }
}
```

- Two separate allow-lists (small tools / platform tools); anything unlisted is hidden
- The debug page (3099) switches workspaces and shows the trajectory; answers render markdown with thinking collapsed
- `container_admin role validate` checks the config, `apply` makes it take effect

### 6.4 Public Q&A page (3100)

- **Key auth** (constant-time comparison + failed-IP lockout + rotatable key) + container allow-list (empty = all open)
- **Answers only**: the response carries answer / answer_html / sessionId — internal trajectory, tool results, and mechanics never leave
- Listens on 127.0.0.1 by default; how you expose it to others (tunnel/reverse proxy/port mapping) is your decision

### 6.5 Autonomous cruising (Autopilot Trajectory)

Let a workspace **wake up on its own and get to work**, in front of you (foreground injection, interruptible):

- **When it wakes**: workspace switch on + global switch on (off by default; enable it only on the machine you want) + target session exists (directory carries the `--auto` suffix) + the interval elapsed (fractions allowed, the tightest about 36 seconds) + outside the quiet window (default 08:00–18:00 Beijing) + the bias script is ready
- **What it reads first**: the "focus" you wrote (`topPrompt`, injected first every round to prevent drift), then randomly generated "bias content" (your script, exploring directions)
- **Workspaces stay independent**: each has its own interval, session, focus, and window
- **Audited**: every wake is recorded (the panel shows the recent ones); failures retry with exponential backoff
- There is no "maximum wakes per day" cap — frequency is bounded only by the interval and the window

### 6.6 Security model

| Layer | What it does |
|---|---|
| Login | scrypt password hashing + constant-time comparison + 256-bit token + 24-hour sliding validity + audit log |
| Two-factor | TOTP (Authenticator-compatible), bound by QR code; password and code are alternatives |
| Brute force | Per-account lockout: 5 consecutive failures → 15 minutes, with exponential backoff |
| CSRF | Login double-submit + Origin check on config writes + server-side token set (multiple tabs do not conflict) |
| Credentials | Centralized in `localstore.json` (git commit denied by default); secret files are structurally isolated from tools |
| Outbound output | Sensitive-wording detection → reject and regenerate, reporting the hit word and how to avoid it |

---

## 7. Configuration has four layers

| Layer | Location | What goes there |
|---|---|---|
| DSH native settings | DSH `settings.yaml` | Simple switches: gateway / rebuild / session naming, rebuild threshold, sub-role switch and debug port, ACP and Q&A page switches, **cruising master switch (off by default)** |
| Plugin global file | `~/.dsh/serenity-hooks.json` (mode 0600) | Gateway accounts (scrypt + TOTP), listen address and ports, workspace allow-list, cookie security switch, Q&A page key |
| Workspace config | `.opencode/serenity.json` | Worker model allow-list, log threshold, safe-mode blocklist, sub-roles, **cruising (interval/session/focus/window)**, **WeChat (accounts/routes/switches)** |
| Workspace credentials | `localstore.json` | Secrets and local preferences; the WeChat bot token lives here too |

> Principle: **the plugin is global, the workspace is specific** — accounts, switches, and thresholds belong to the plugin layer; roles, credentials, and local preferences belong to the workspace layer.

---

## 8. When context fills up

The AI can only "remember" so much at a time. You do not have to start a fresh session:

| Mechanism | In plain words |
|---|---|
| **Work log (SESSION.md)** | The AI's notebook, and it never moves. Goals, decisions, progress all live there |
| **In-place rebuild (`logbook rebuild`)** | When it fills up, the AI is prompted to rebuild: this conversation is cleared, but "who you are + continue S###" is injected again — **the carrier is replaced, the work continues**. Token accounting settles correctly afterwards |
| **Progress reminders** | After long stretches it scores the work and reminds the AI to write progress back, expecting a confirmation code |
| **Sedimentation discipline** | If rebuilding produced valuable insight, it is written into the relevant skill first, not thrown away |

---

## 9. For plugin developers

```bash
pnpm typecheck          # type check (node + browser halves)
pnpm test               # full suite (currently 75 files / 1110 tests)
pnpm build              # bundle (lib/index.js + client.js)
```

- **Development tool**: `scripts/dsh-develop.ts` — typecheck / test / build / status / commit / push / version / bump / deploy / restart-web / publish / pack-check / github-push in one place.
  `pack-check` verifies the packaged artifacts before publishing (we once shipped an npm release missing files);
  `scripts/dsh-crash-investigate.ts` is a read-only crash investigator
- **Architecture**: a Cordis-native plugin registering tools and interception points through DSH's official interfaces — **DSH itself is never modified**
- **Code map**: [docs/codebase-overview-v1.22.md](docs/codebase-overview-v1.22.md)
- **Design decisions**: see [CHANGELOG.md](CHANGELOG.md) and the maintenance skill `dsh-serenity-plugin-development`
- **Release**: npm `@shgroup/dsh-serenity-hooks` + two GitHub remotes pushed together

---

## 10. Relationship to the opencode version

| | opencode-serenity-plugin | dsh-serenity-plugin (this repo) |
|---|---|---|
| Runs on | OpenCode | DeepSeek Harness |
| Implementation | Independent | **Independent** (no shared source, same standard) |
| System prompt | `system.transform` | `systemPrompt.section`, platform-independent text aligned byte-for-byte |
| Tools | msm / container_fs / logbook … | container_fs / logbook / dashboard / container_git / msm / praxis / handyman / localstore / container_admin / autopilot-trajectory / im-bridge |

**A workspace can switch runtimes at any time**: the `.serenity` marker, `.opencode/skills/`, configuration, and `AGENT_SESSIONS/` formats are identical.
Only the platform layer differs (tool names, injection channel), and the constraints the AI receives stay the same.

---

## 11. FAQ

**Q: Nothing happens after installing?**
Check that you are inside a directory marked with `.serenity`. Outside a workspace the plugin does not intervene at all. Once inside, run `dashboard health` to see the three checks.

**Q: Where did bash go?**
Safe mode is on — that is the design, not a bug. Registered small tools are more reliable than letting the AI assemble commands. Toggle the SAFE slider back to restore it.

**Q: The 3081 login is locked?**
Five consecutive failures lock it for 15 minutes (exponential backoff). Wait it out, or check the account's code-binding status.

**Q: Context is nearly full?**
Have the AI write progress back to SESSION.md, then follow the prompt and call `logbook rebuild`. The trajectory continues automatically — no new session needed.

**Q: Does the public Q&A page leak internals?**
No. It returns only the answer; internal trajectories and tool results stay inside.

**Q: How does the AI's reply actually reach WeChat?**
By default the plugin forwards its final message for you. With `autoReplyWithLastMessage: false`, the plugin stops forwarding and the AI sends messages itself — so if it sends nothing, you receive nothing (no fallback; that is deliberate).

**Q: Are proactive WeChat messages recorded?**
Yes — through the same `weixin.hook` script configured in the workspace, with `source: "proactive"` in the event; automatic replies carry `source: "reply"`.

---

## 12. Further reading

- **Where the ideas come from**: [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) — what a cognitive container is, the "happening / storing / re-happening" loop, trajectory and carrier
- **The authoritative standard**: [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) — theory foundation, injection spec, invariants
- **What changed**: [CHANGELOG.md](CHANGELOG.md) — what each version did and why

---

## License

MIT (see [LICENSE](LICENSE))

> **Version**: v1.31.1 &nbsp;|&nbsp; **Requires**: DSH 0.1.2-rc.1+ / Node ≥ 20 or bun &nbsp;|&nbsp; **Tests**: 75 files / 1110 tests
