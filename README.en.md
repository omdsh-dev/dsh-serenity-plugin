# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **Not a sandbox — a cognitive container.** A Serenity ACC (Abstract Cognitive Container) implementation for the DeepSeek Harness (DSH): real tools, mechanical constraints, system-prompt injection, and a WebUI status badge for DSH sessions.
>
> Targets [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc and later.

## What is this

[opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) is the Serenity ACC for OpenCode; this repository is an **independent implementation for DSH**.

- **Independent**: does not reuse opencode-serenity-plugin source; aligns to the same ACC standard (tool set + mechanical guards + collaboration discipline), with the injected system prompt **byte-aligned on platform-neutral text** (see below).
- **Primary artifact = native Cordis plugin** (`@shgroup/dsh-serenity-hooks`): real DSH tools (registered in-process via `ctx.tools.register`) + interception-seam mechanical constraints.
- **Knowledge layer = skills** (acc-serenity etc.): knowledge only; constraints are enforced mechanically by the plugin.
- **Platform reuse**: path guards (fs sandbox), loops/residents (goal/subagent), compaction retention are native DSH capabilities reused as-is.

## Features

| Capability | Description |
|-----------|-------------|
| **9 real DSH tools** | `cc_fs` (15 fs subcommands) / `session` (full session lifecycle) / `acc_kit` / `cc_git` / `acc_msm` (MSM framework) / `eap` / `neat` / `cce` / `loop` — all registered via `ctx.tools.register` |
| **System-prompt injection (5 blocks)** | `systemPrompt.section` (global, order -50): `=== Serenity ACC ===` / `=== Serenity CCE ===` / `=== Serenity Constraints ===` / top-level entry skill full text (discovered via the `.serenity` marker) / `=== Serenity Session ===` — aligned to opencode-serenity-plugin `system.transform`, byte-identical on platform-neutral text |
| **Interception-seam guards** | safe-mode (bash disappears from the tool list) / path-escape blocking (P3: full inside Root, zero outside) / blacklist / governance-file protection / session-keeper DCP reminders — not bypassable by the model |
| **Compaction retention** | Re-injects ACC identity after `compaction/end` (compaction never loses CCC constraints) |
| **WebUI status badge** | Session-header green status dot + safe-mode toggle; click to expand a detail card (CCC root / loop model / guard info) |
| **Activation gating** | Everything activates only inside a CCC directory marked with `.serenity`; zero effect on DSH behavior elsewhere |

## Why MSM beats bash — why safe-mode exists

> Safe-mode exists not because disabling bash is convenient,
> but because **written and tested MSMs are more reliable and safer than raw bash**.

Turning safe-mode on makes bash **disappear from the model's tool list** (via DSH `tools.restrict`, refreshed each step) — not an error on call, the model simply never sees it. The agent is forced onto the MSM whitelist channel: registered, tested, bounded, deterministic operations. The toggle is a **user capability** (WebUI only; invisible to and not controllable by the agent).

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

### Option 2: install from GitHub source

```bash
dsh plugin --profile web add github:tellmewhattodo/dsh-serenity-plugin
```

> A git install fetches sources: the author ships a self-contained `prepare` build (this package does), and the user must allow the build script under `allowBuilds` in the profile's `pnpm-workspace.yaml`, plus pin a commit (`github:user/repo#<sha>`).

### Option 3: local development install

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

Sessions inside a CCC automatically get: the 9 ACC tools, mechanical guards, ACC identity injection, entry-skill system prompt, session-keeper reminders, and the WebUI status badge.

## System prompt (aligned with opencode-serenity-plugin)

Five blocks in the same order (ACC → CCE → Constraints → SKILL full text → Session); CCE / Constraints / Session text is **byte-identical** (mechanically asserted in `hooks/dsh-serenity-hooks/tests/osp-alignment.test.ts`). The only platform differences are tool names (DSH's real tools) and governance-content filtering in the SKILL block.

## Development

```bash
pnpm typecheck   # hooks/dsh-serenity-hooks (node + client)
pnpm test        # vitest full suite (184 tests)
pnpm build       # tsc + tsdown dual bundle (lib/index.js + client.js)
```

Typecheck runs against real DSH type contracts (tsconfig paths point at a local DSH install, see `hooks/dsh-serenity-hooks/tsconfig.json`).

## Relationship to opencode-serenity-plugin

| | opencode-serenity-plugin | dsh-serenity-plugin |
|---|------|------|
| Host | OpenCode | DeepSeek Harness |
| Implementation | independent | **independent** (no source reuse) |
| System prompt | `system.transform` | `systemPrompt.section`, byte-aligned on platform-neutral text |
| Tools | msm_list/exec/cc-fs/session etc. | cc_fs/session/acc_msm/cc_git/eap/neat/cce/loop |

## Interchangeable CCC runtime (osp or dsh)

**A CCC is decoupled from its runtime plugin — any CCC can switch between opencode-serenity-plugin and dsh-serenity-plugin as its ACC runtime:**

- **CCC file formats are runtime-independent**: the `.serenity` marker (content = top-level entry skill name), `.opencode/skills/` (knowledge skills), `.dsh/serenity.json` (config), `AGENT_SESSIONS/` (session tracking) — both plugins read and write the same files with the same semantics.
- **Choose either**: install opencode-serenity-plugin on an OpenCode host, or this plugin on a DSH host; the same CCC can switch runtimes at any time without touching skills or existing data.
- **Differences are platform-only**: tool naming (`msm_exec`/`cc-fs` vs `acc_msm`/`cc_fs`) and the system-prompt injection channel (`system.transform` vs `systemPrompt.section`) — platform-neutral text is byte-aligned, so the agent receives identical cognitive constraints after switching.

## License

MIT — see [LICENSE](LICENSE)

> **Version**: v1.16.0 &nbsp;|&nbsp; **Prereqs**: DSH 0.1.0-rc+ / Node ≥ 20 / bun
