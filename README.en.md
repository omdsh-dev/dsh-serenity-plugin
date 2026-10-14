<!-- TODO(sync): 与 README.md 存在内容差异，待同步；本行由 S142 语域修订留下 -->
# Serenity ACC — an "AI workspace" for DeepSeek Harness

> **In one line**: on install, this plugin designates an ordinary directory as the AI's workspace. Inside it, the AI gains **memory, discipline, tools, and boundaries**, so work can continue after a model switch, a reboot, or a night's sleep.
>
> Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 0.1.5-rc.2 or later.
> For the reasoning behind it (why "cognitive container"), see [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md). This README states **what it does and how to use it**.

**Four terms, defined once** (used throughout, not repeated):

| Term | Definition |
|---|---|
| **Workspace / CCC** | A directory containing an empty `.serenity` marker file. Elsewhere, the plugin does nothing at all; on opening a session inside such a directory, it activates |
| **Plugin / ACC** | This repository (npm package `@shgroup/dsh-serenity-hooks`). It adds tools, constraints, and memory to DSH |
| **MSM** | A small executable tool written inside the workspace (one script + one registry line). The AI calls it with `msm("name", ["args"])` |
| **SESSION.md** | The workspace's work log. The AI writes goals, decisions, and progress there, so an interrupted task can resume from it |

---

## 1. What problem it solves

Four recurring problems, stated directly:

| Problem | Without it | With it |
|---|---|---|
| **The AI forgets what it was doing** | Context fills up; prior goals and decisions are lost, and the task must be re-explained | Every workspace keeps a work log the AI updates as it goes. When context fills up, it swaps the carrier and continues — the log never moves |
| **The AI reads and edits files without boundary** | It can read the entire machine, keys included | The workspace has walls: everything inside is permitted, everything outside is refused — secret files cannot even be read |
| **Use away from the desk** | Requires sitting at that machine | It ships a login-protected web entry (password or phone code), so a phone works too |
| **Family members asking over WeChat** | Requires teaching them to install software and boot a computer | Scan a QR code once, and they simply message it on WeChat; it answers in the configured persona |

---

## 2. Quick start (2 minutes)

Prerequisites: Node ≥ 20 (or bun), DSH 0.1.5-rc.2 or later.

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

Install from source (when the code itself is being changed):

```bash
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks
```

> ⚠️ Do **not** use `dsh plugin add github:...` — that URL points at the repository root package (a workspace container, not the plugin itself) and will not activate. Use npm or the `link:` form above.

**Safe mode**: after flipping the SAFE slider on the web capsule, `bash` is **removed from the AI's tool list** (not an error — the model simply cannot see it). The AI can then call only the small tools that were registered and tested. The switch belongs to the operator: the AI can neither see it nor flip it.

---

## 3. What the install adds

### 3.1 The eleven tools (two appear conditionally)

| Tool | What it does | When to use it |
|---|---|---|
| `container_fs` | File handling inside the workspace: list, find, copy, move, create, append, reveal in file manager | When workspace files must be inspected or tidied |
| `container_trajectory` | **One trajectory**: its body (SESSION.md) plus its timeline. Beyond create / show / switch / in-place rebuild, it registers a **future wake** (a wake = a future instant + one message; it can wake yourself, or another trajectory) | Any multi-step job — this is step one; also to have the AI resume work at a future instant |
| `dashboard` | Instruments: workspace health (three checks), current time, wait | Self-check before working; wait on external services |
| `container_git` | Git: status / commit / push / log / pull / diff | Commit and push; it never force-pushes on its own |
| `msm` | The execution entry for small tools: `msm("name", ["args"])`; partial names return candidates; `inspect=true` shows usage | Calling any registered tool in the workspace |
| `praxis` | Injects one of three "ways of working" on demand: output self-check (eap), design alignment (neat), cognitive continuity (cce) | When precision is required, or alignment before building |
| `handyman` | A low-cost worker model executes the task. **Default mode (foreground)** = one serial delegation that returns its result; **background mode** = rounds until done (completion-code check / round cap / auto-restart / progress file), and several jobs in parallel | Bulk, repetitive work (scanning dozens of skills, per-case regression) |
| `localstore` | Stores secrets and settings (credential and config namespaces) | API keys and passwords in one place, outside git |
| `container_admin` | The maintenance bay: manage sub-roles, manage the small-tool registry, view all configuration | Defining a sub-role, registering a new small tool, changing configuration |
| `im-bridge` | Message an IM contact (WeChat today): send text, send a file, list configured recipients, check channel health. Every successful send is recorded in the workspace log | When the AI must message family/colleagues proactively (see §6.6). **It appears only when this workspace has the WeChat bridge configured**, and it can message from this workspace only |
| `acc-diag` | ACC runtime diagnosis: one call returns the full report — which sessions are live and which workspace each belongs to, the cruising target/agent resolution, every entry in the wake registry, and the condition chain for "why did this round not wake" | **ACC maintainers only.** **Hidden from every workspace by default**; it appears only in a workspace that names it (config `exclusiveTools`) |

> **Renamed** (old names are gone for good, no aliases): each arrow chain below lists the name **as shipped in each release** — the **last item is the current name**: `cc_fs` → `container_fs` · `cc_git` → `container_git` · `session`+`session_rebuild` → `logbook` (v1.30/1.31) → `trajectory` (v1.32) → **`container_trajectory`** (v1.34, current) · `acc_kit` → `dashboard` · `acc_msm` → `msm` (execution) + `container_admin` (management) · `eap`/`neat`/`cce` → `praxis` · `skiff_admin` → `container_admin role` · `autopilot-trajectory` → `trajectory` (v1.32) → **`container_trajectory`** (v1.34, current; **its cruising controls were retired in v1.35.0**). Old sessions referencing the old names will error — always take the **last item of the chain** as the live name.

### 3.2 Mechanical constraints (the AI cannot bypass them)

These are not "please don't" hints in a prompt — they are **mechanically impossible**:

| Constraint | What will be observed | Why it is built this way |
|---|---|---|
| **Safe mode** | bash vanishes from the tool list (synced every step); even an attempted call is denied as a fallback | Registered, tested tools are more reliable than letting the AI assemble shell commands |
| **Workspace walls** | Everything inside works, everything outside is refused (the path never even resolves) | The AI should not touch anything outside its workspace |
| **Blocklist / governance files** | A configurable blocklist; `.serenity` and similar governance files cannot be written | So the AI cannot damage the foundation it stands on |
| **Secret-file guard** | `localstore.json` is denied to **every** tool (read/grep/glob included) | Secret values are structurally unable to leave |
| **Outbound output guard** | On outward-facing sessions (sub-role / ACP / rebuilt sessions), sensitive wording is rejected and regenerated, with the hit word and guidance reported | Outsiders should not see internal mechanics |
| **Trajectory reminders** | After long stretches it reminds the AI to write progress back to the log and expects a confirmation code | The reminder is a mechanism, not a reliance on self-discipline |
| **Logbook size reminder** | When the work log (SESSION.md) passes 200KB it tells the AI to stop and rewrite it, with four rewrite principles (keep the skeleton / move detail into attached files / merge what no longer matters / the rest is the AI's call) | A log too long to finish reading has no readers; rewriting costs less than accumulating. The limit is per workspace (`sessionKeeper.sessionMdMaxKB`, 0 = off) |
| **Handover before rebuild** | Before rebuilding context it asks the AI to write "where I am / what is unfinished / the next action" at the very **end** of the work log under a fixed heading; the rebuilt self reads that section first and continues | The context is discarded, but the in-flight work must not be — write and read sides share one heading, so the section can be found |

### 3.3 Entry points

| Entry point | Default port | Who uses it |
|---|---|---|
| DSH main UI | 3080 | Local use by the operator (the plugin never touches this port) |
| **Web login entry** | 3081 | Remote/phone access to the full UI: reverse-proxies to 3080 after login; workspace allow-list supported |
| **WeChat proactive send** | 3082 (127.0.0.1 only) | Scripts/integrations *outside* the workspace use it to message WeChat users (not reachable from the internet, so no key is needed). The AI inside a workspace does not use this port — it calls the `im-bridge` tool directly |
| **Sub-role debug page** | 3099 (127.0.0.1 only) | Debugging "sub-roles"; switch workspaces and inspect the conversation |
| **ACP + public Q&A page** | 3100 (127.0.0.1 only) | Programmatic access (JSON-RPC) + a Q&A page for others (key auth; answers only, no internal trajectory) |
| **WeChat bridge** | no port (outbound long-poll) | Family members talking to the AI directly in WeChat |

> Entry points that default to 127.0.0.1 are exposed at the operator's discretion (tunnel, reverse proxy, or port mapping). The plugin does not prescribe any particular method.

### 3.4 One less step: using opencode models

Using the opencode gateway (`opencode.ai/zen`) from DSH normally requires configuring a route *and* hand-copying a
handful of request headers — opencode uses them for **session-affinity routing**, and without `x-opencode-session`
the `/zen/go` endpoint answers **400** outright. **The plugin configures this on install**:

| Situation | Plugin behaviour |
|---|---|
| An opencode route exists but lacks headers | Fills in only the missing ones; **operator-written values are never overwritten** (header names are case-insensitive — `X-Title` and `x-title` count the same) |
| No opencode route exists, but `OPENCODE_API_KEY` is present in the environment | Creates the `opencode-go` route with the full header set (nobody without a key is affected — no surprise extra models) |

- **Only the "session family" of headers**: `x-opencode-session` / `X-Session-ID` / `x-opencode-client` /
  `x-opencode-project`. The first two are **two alias names for the same value** — write either one and the plugin
  fills in the other with **that value**, so two conflicting session ids cannot arise
- **Injection scope is bounded by what the endpoint requires**: `/zen/go` returns **400** when the session-family
  headers are missing, so they are supplied; `X-Title` / `HTTP-Referer` are client identity headers and are not
  required by the endpoint, so they are not injected.
  `User-Agent` is a reserved name in DSH and cannot be overridden
- **The session id is a fixed value** (`dsh-serenity`): DSH resolves request headers once, at route-resolution
  time, so a static value is the only option. The upside is that requests from one machine land on a stable
  upstream (cache-friendly); the cost is that per-session partitioning is out of reach
- **It writes the operator's own file**: the headers go into DSH settings
  (`llm-pi-ai.providers.<route>.headers`) — readable, editable, deletable. To disable the auto-config,
  turn off this plugin's `opencodeProvider.autoConfigure` (all behaviour reverts to manual header copying)
- **The key is untouched**: the plugin only adds routes and headers; just put `OPENCODE_API_KEY` in the environment

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

## 5. What it can do (12 real use cases)

> All of these run in a real deployment. Addresses, accounts, and paths are generalized.

| # | Objective | Actual path |
|---|---|---|
| 1 | **Keep a long project alive** | `container_trajectory create` → write progress as work advances → resume with `container_trajectory use` after an interruption → `container_trajectory rebuild` when context fills up, continuing automatically |
| 2 | **Sync code in bulk** | `container_git commit/push` in the current repo; one command syncs every sub-repo (auto commit + push) |
| 3 | **Produce one episode of subtitles** | Find the source → download → Whisper transcription → translation → bilingual SRT → mechanical QC (7 checks) → push to subscribers/email |
| 4 | **Server inspection** | One command returns CPU/memory/GPU/containers/services; restarting a container goes through the same allow-listed channel |
| 5 | **Locating internal services** | Repository overview (categories/stack/links) + device and port scanning |
| 6 | **Household finance** | Structured records for assets/liabilities/income/expenses/budgets, queryable anytime; mortgage-rate comparisons and similar macro tracking |
| 7 | **Family profiles** | One maintained source of truth for each member's data |
| 8 | **Recording ideas** | Free-form conversation; the AI interviews to structure it, and periodically reviews thinking patterns |
| 9 | **Phone / remote use** | Open `http://LAN-IP:3081` → password or a 6-digit code → full UI on the phone |
| 10 | **Paste and let it process** | Paste an image → saved automatically → vision model reads it (delivery slips, screenshots, charts); paste a PDF/archive → saved → extract text, unpack, read tables |
| 11 | **Use the AI in WeChat** | Scan once from the settings panel → family members send text/voice/images/files → routed to a chosen sub-role → the reply lands back in WeChat |
| 12 | **Let it work on a schedule** | Configure cruising (interval / target session / focus / bias script) → it wakes on time with its focus injected, visible and interruptible at any moment |

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
- **Clean replies**: the thinking process is stripped; WeChat shows only the final text
- **Session persistence**: one WeChat user maps to a fixed session that survives restarts
- **Routing**: WeChat user → sub-role (exact match first, `*` as fallback)
- **Proactive messages** (v1.31.0): the AI sends them itself with the `im-bridge` tool —
  `im-bridge({channel:"weixin", action:"send", user:"yh", text:"text"})`
  (files: `action:"send-file"` + `file:"<path inside the workspace>"`, optional `caption`).
  The tool **can only message from this workspace** (there is no "target workspace" parameter, so it cannot
  message the wrong container), and every send is recorded automatically. It **appears in the tool list only
  when this workspace has the WeChat bridge configured** — otherwise it is hidden entirely, not "visible but failing".
  (The old approach — a workspace script talking to port 3082 — is retired as of v1.31.0; 3082 stays for scripts outside the workspace.)
- **Let the AI decide how to reply** (v1.30.10): with `"weixin": { "autoReplyWithLastMessage": false }`
  the plugin no longer forwards the AI's final message; instead it tells the AI on every turn "you must send it yourself"
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
- Listens on 127.0.0.1 by default; the exposure method (tunnel/reverse proxy/port mapping) is the operator's decision

### 6.5 Trajectories and message delivery (trajectory)

`trajectory` (a trajectory) is the first-class concept: one workspace may run any number of trajectories in parallel, and each one's `SESSION.md` is its **persistent body** (the chat session is only its rebuildable carrier).

**Scheduled delivery**: `container_trajectory send-later` registers a wake = a future instant + one message — book it for yourself, or wake another trajectory. It lands in the workspace's `AGENT_SESSIONS/wake-registry.json` (readable and auditable) and a central scheduler delivers it when due — **no blocking, no waiting, and no receipt**.

**Instant delivery**: `container_trajectory send-now` hands a message over **right now**, and it is **never queued** — if the target is in memory and **mid-round**, it is `steer`ed **into the current round**; if the target is idle, a round starts immediately; if it is not in memory, it is **cold-loaded first and then delivered** (equivalent to a direct wake, but **not waiting for the scheduler's 5-minute tick**). It returns a **synchronous receipt** (stating whether it went live or cold-resume) and does **not** touch the registry (that table is only for "future instants").

- The two differ in exactly two ways: **when** (now / future) and **receipt** (yes / no). Booking is innately fire-and-forget (no recall, no receipt), while handing over is one call and one answer — **each has clean semantics; the two are deliberately not crammed into a single action**. (🔴 **Renamed**: this pair used to be `wake-later` / `send-message`; it is now **`send-later` / `send-now`** — the family shares the stem `send-`, and the axis is `-later` / `-now`, because "waking" is a property **both** paths have and therefore cannot tell them apart. **Hard cut, no aliases.**)
- ⚠️ **The receipt only means "injected / round started"**: it does **not** mean the target has run or replied. To confirm the target actually moved, read **its own `SESSION.md`** (a file-level criterion) — **never close the loop on the receipt alone**.
- ⚠️ **The one exception path**: when `steer` is unavailable it **falls back to queueing** (fail-safe: **queueing is preferable to silently dropping the message**) — the receipt text says so explicitly. **`send-later` is unaffected**: booking exists to wake the target at a due instant, and "queue rather than interrupt the current round" is behaviour that has been empirically validated for it.
- **A closed target can still be woken**: if the session is not in memory it is loaded first (**cold wake**); if it cannot be loaded, the entry stays in the registry with the reason recorded — **never silently dropped**.
- **"Periodic" belongs to the workspace**: to go round after round, the **receiving** trajectory schedules the next round at the end of each round. ACC provides only the primitive "deliver one message when due" — it does not decide the cadence for the workspace (focus, cadence and bias are the workspace's own; any number of trajectories run in parallel, independent of each other).
- **A trajectory can carry skills** (two forms, **unioned**): ① **declare once, the whole workspace inherits** — put `trajectory.skills: [name, …]` in `.opencode/serenity.json` and **every trajectory in this workspace** gets the full text of those skills injected while it is bound (**skiff role sessions included**); ② **this one trajectory only** — write `skills: [name, …]` in the top frontmatter of its `SESSION.md`. The two are unioned: workspace-level first (the base), trajectory-level appended (the extra). ⚠️ This is "**kept supplied for as long as it is bound**", not "poured in once at `use`" — editing the config or the frontmatter takes effect **immediately**, and it does not disappear on compaction. `create` merely creates: it **does not steal the current binding**, so a new trajectory must be **explicitly `use`d** before its skills are injected. Skill names come from workspace data and are **safety-checked before they are ever used to build a path**; a missing skill is reported as "missing" in the prompt rather than **silently skipped**. ⚠️ **Keep the top frontmatter intact when rewriting `SESSION.md`** — losing it silently revokes that trajectory's declaration.

#### CRO — let a trajectory decide **when it should be woken**

**The problem**: both actions above require a **pre-computed instant** ("wake me at 3"). But **whether to wake is often not a matter of time**: a trajectory should only wake when "it is daylight + someone is home + not peak hours"; if it is already working it should not be woken again; if its log is nearly full, the next wake should **ask it to tidy up first**.

**The approach**: **let a trajectory carry its own program**, which ACC runs on every check — **that program decides "should I be woken now, and what should the wake say"**.

| | |
|---|---|
| **Where the program lives** | `<CCC root>/AGENT_SESSIONS/<trajectory dir>/continuous-re-occurrence.ts` (inside the trajectory's **own directory** ⇒ it survives carrier changes and is version-controlled with git) |
| **Switch** | 🔴 **There is none** — **file present = enabled, file absent = disabled** (no enabled field, no registry) |
| **Who runs it** | ACC's wake scheduler (the existing **5-minute** tick) |
| **What it receives** | a **JSON snapshot** on stdin: identity / time / trajectory body (SESSION.md size and mtime, `references/` listing) / binding and carriers (bound, live, and 🔴 **currently running a round**) / scheduling (this trajectory's pending wakes, scheduler state) |
| **What it returns** | **one line of JSON** on stdout: `{"wake":true,"prompt":"…","reason":"…"}` or `{"wake":false}` (**absent = do not disturb**) |
| **Read before writing** | `container_trajectory cro-guide` — the **guide plus a ready-to-use sample snapshot** |

**Hard constraints that shaped the design** (none of them arbitrary):

- 🔴 **ACC only spawns a process — it never imports the program.** The process boundary resolves two risks at once: ACC does not depend on the workspace's **source path** (an installed copy lives elsewhere, and two paths means two sources of truth), and **a syntax error in one user program cannot take down the whole container**.
- 🔴 **A half-finished program may simply fail**: it errors / times out (hard 60-second timeout, then killed) / emits invalid output ⇒ **one log line + skip this round**.
- 🔴 **No CRO failure may affect the existing mechanisms** — `send-later` / `send-now` / registry delivery keep working. This one is pinned by a real test, not a verbal promise.
- 🔴 **Fill in `reason`**: once a program decides, "why was I woken then" **can no longer be reconstructed from the timetable** (the reason exists only inside the program); without it, an incident cannot be replayed.
- **If the program wants to remember what it decided last time, it records that itself** — a state file in **its own trajectory directory** (that state lives in its own process; ACC cannot reach it). So **debouncing is the program's job too**: if it wants "do not wake me too often", it keeps its own timestamp.
- ⚠️ **It is not self-testing**: the guide's recommended flow is to **write it under a dev name first** (e.g. `continuous-re-occurrence.dev.ts`, which is **not** enabled) → get the self-test green → **then rename it to the real name** (because "file present = enabled", **the rename is the go-live action**).

> 🔵 **This is not a comeback of autopilot**: what retired was the **decision content** (periodic cadence + prompts); the **scheduling capability** stayed. CRO adds what a workspace cannot do itself — **deciding whether to wake while nobody is awake** (a workspace's own scheduling only runs *when it is woken*).

- ⚠️ **History (retired in v1.35.0)**: ACC used to ship its own "**periodic self-wake autopilot**" — an in-plugin clock + a `topPrompt`/bias script + the "periodic self-wake" panel switch + the `container_admin autopilot` actions. **Removed entirely in v1.35.0.** Reason: over a plain wake it added only two things — a **periodic cadence** and **prompt injection** — both of which a workspace can do itself; and it was actually **weaker** (it required the target session to be **in memory**, whereas a wake supports **cold** sessions). Older wording such as `container_admin autopilot`, `autopilot-trajectory`, the `--auto` directory suffix or `[Autopilot Trajectory · 唤起]` should all be read through this note: **that mechanism is gone.**

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
| DSH native settings | DSH `settings.yaml` | Simple switches: gateway / rebuild / session naming, rebuild threshold, sub-role switch and debug port, ACP and Q&A page switches, **cruising master switch (off by default)**, **opencode route auto-config (on by default)** |
| Plugin global file | `~/.dsh/serenity-hooks.json` (mode 0600) | Gateway accounts (scrypt + TOTP), listen address and ports, workspace allow-list, cookie security switch, Q&A page key |
| Workspace config | `.opencode/serenity.json` | Worker model allow-list, log threshold, safe-mode blocklist, sub-roles, **cruising (interval/session/focus/window)**, **WeChat (accounts/routes/switches)** |
| Workspace credentials | `localstore.json` | Secrets and local preferences; the WeChat bot token lives here too |

> Principle: **the plugin is global, the workspace is specific** — accounts, switches, and thresholds belong to the plugin layer; roles, credentials, and local preferences belong to the workspace layer.

---

## 8. When context fills up

The AI's memory of a session is bounded. A fresh session is not required:

| Mechanism | Description |
|---|---|
| **Work log (SESSION.md)** | The AI's notebook, and it never moves. Goals, decisions, progress all live there |
| **In-place rebuild (`container_trajectory rebuild`)** | When it fills up, the AI is prompted to rebuild: this conversation is cleared, but "who you are + continue S###" is injected again — **the carrier is replaced, the work continues**. Token accounting settles correctly afterwards |
| **Progress reminders** | After long stretches it scores the work and reminds the AI to write progress back, expecting a confirmation code |
| **Sedimentation discipline** | If rebuilding produced valuable insight, it is written into the relevant skill first, not thrown away |

---

## 9. For plugin developers

```bash
pnpm typecheck          # type check (node + browser halves)
pnpm test               # full suite (currently 80 files / 1186 tests)
pnpm build              # bundle (lib/index.js + client.js)
```

- **Development tool**: `scripts/dsh-develop.ts` — typecheck / test / build / status / commit / push / version / bump / deploy / **lockfile** / **host-upgrade** / restart-web / publish / pack-check / github-push in one place.
  `lockfile` regenerates the lockfile and self-checks it with `--frozen-lockfile` (the same verdict CI's `Install (hooks)` uses);
  `pack-check` verifies the packaged artifacts before publishing (an npm release once shipped with files missing);
  `scripts/dsh-crash-investigate.ts` is a read-only crash investigator.
  ⚠️ **After changing `package.json` dependencies you must run `lockfile` and commit the lockfile** — v1.31.6 skipped it and CI stayed red ever since (red as "the tests never ran"; see CHANGELOG v1.31.10)
- **Host type baseline = devDependencies** (v1.31.11): the `paths` in `tsconfig.json` / `client/tsconfig.json` point at **in-repo** `node_modules/@deepseek-ai/*`, supplied by exactly pinned devDependencies → **a new `paths` entry must be accompanied by a devDependency** (otherwise tsc silently falls back to node_modules = false green, and CI's typecheck is a gate in name only). Mechanically guarded by `tests/compliance.test.ts` F7; on a host upgrade only `package.json` changes (+ re-run `lockfile`)
- **Upgrading the host** (v1.31.12): `dsh-develop host-upgrade <version|dist-tag>` upgrades the global DSH CLI (package name hard-coded to `@deepseek-ai/dsh`, official registry by default, `--dry-run` to preview) → raise the `package.json` peer/devDeps baseline to the same version and re-run `lockfile` (`compliance.test.ts` F6c/F7d and `host-manifest.test.ts` force every declaration surface to stay in sync — miss one and the suite goes red) → `restart-web` → check `dshVersion` via `dashboard health`
- **Diagnosing "session won't open"** (v1.31.13): `dsh-develop session-doctor` — a **read-only** session-log health check. `--probe` judges through the host's **real read path** (`msm("dsh-develop", ["session-doctor","--probe","--summary"])` runs it across every session).
  ⚠️ Two easy misreads: ① `readStoredLog` is a **storage-level** read that **does not run format migration**, so its "no upgrade path" error for historical generations is **normal, not evidence of corruption** — "can the user open it?" is decided by the app-level `open(id,'read')`. ② The two real defects this tool surfaced are in CHANGELOG v1.31.13 (`rebuild` wrote a `user/message` payload missing `id`/`role` ⇒ sessions became **permanently unopenable**; `findSessionLog` did not recognise `session.vN.jsonl.zstd` ⇒ cleanup silently did nothing)
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
| Tools | msm / container_fs / logbook … | container_fs / container_trajectory / dashboard / container_git / msm / praxis / handyman / localstore / container_admin + two conditional ones (`im-bridge` / `acc-diag`) |

**A workspace can switch runtimes at any time**: the `.serenity` marker, `.opencode/skills/`, configuration, and `AGENT_SESSIONS/` formats are identical.
Only the platform layer differs (tool names, injection channel), and the constraints the AI receives stay the same.

---

## 11. FAQ

**Q: Nothing happens after installing?**
Check that the session is inside a directory marked with `.serenity`. Outside a workspace the plugin does not intervene at all. Once inside, run `dashboard health` to see the three checks.

**Q: Where did bash go?**
Safe mode is on — that is the design, not a bug. Registered small tools are more reliable than letting the AI assemble commands. Toggle the SAFE slider back to restore it.

**Q: The 3081 login is locked?**
Five consecutive failures lock it for 15 minutes (exponential backoff). Wait it out, or check the account's code-binding status.

**Q: Context is nearly full?**
Have the AI write progress back to SESSION.md, then follow the prompt and call `container_trajectory rebuild`. The trajectory continues automatically — no new session needed.

**Q: Does the public Q&A page leak internals?**
No. It returns only the answer; internal trajectories and tool results stay inside.

**Q: How does the AI's reply actually reach WeChat?**
By default the plugin forwards its final message for you. With `autoReplyWithLastMessage: false`, the plugin stops forwarding and the AI sends messages itself — so if it sends nothing, no message arrives (no fallback; that is deliberate).

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

> **Version**: v1.31.12 &nbsp;|&nbsp; **Requires**: DSH 0.1.5-rc.2+ / Node ≥ 20 or bun &nbsp;|&nbsp; **Tests**: 80 files / 1180 tests
