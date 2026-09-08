# Slice G — Declaration Surface (manifest / config / docs vs reality)

> Reviewer: main thread (S142). Scope: the declarations that tell the host, npm, and users what dsp
> IS and what it REQUIRES — as opposed to what it does. Evidence: dsp repo files + host
> `AI_LAB/dsh-harness-public` @ 0.1.2-rc.1 (production version).

## 1. Verdict summary

| Class | Count |
|---|---|
| Verified consistent | 5 |
| Inconsistent / stale | 8 |
| Unguarded (no check would catch drift) | 6 |

## 2. Verified OK

| Contract | dsp site | Reality | Verdict |
|---|---|---|---|
| Tool set, 3-way | `dsh.plugin.json` contributes.tools (10) / `src/invariant.ts:48-51` REGISTERED_TOOLS (10) / 10 `defineTool` registrations (`src/tools/*.ts`) | identical, v1.30 names | ✅ |
| Version, 3-way | `package.json` / `dsh.plugin.json` / `CHANGELOG.md` = 1.30.5 | `dsh-develop version` → 三处一致 | ✅ |
| Host peer range | `package.json:54-71` 16 peer deps all `^0.1.2-rc.1` (schemastery ^3.18.1, cordis ^4.0.0-rc.7) | matches running host 0.1.2-rc.1 | ✅ |
| npm tarball completeness | `files[]` = `lib/*.js` + `lib/*.d.ts` + `lib/**/*.d.ts` + manifest + cordis patch + experiments | pack-check 81 files, lib 75 (js 12 / d.ts 63) | ✅ |
| Client bundle purity | `tsdown.config.ts:69-78` purity plugin rejects non-platform `@deepseek-ai/*` value imports | enforced at build time | ✅ |

## 3. Findings

| ID | Severity | Declaration | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| G-1 | P2 | `engines.dsh` floor contradicts `peerDependencies` | `dsh.plugin.json:6-8` `">=0.1.0-rc.5"` vs `package.json:54-71` `^0.1.2-rc.1` | Documentation-only mismatch **in practice**: verified the host does NOT read or enforce `engines.dsh` (grep across `AI_LAB/dsh-harness-public` finds no plugin-manifest engines check — only unrelated Node-engine references), so it neither gates installs nor warns; the real gate is peerDependencies resolution. The danger is the *false assurance*: a reader (and any future host that starts honoring it) believes the floor is 0.1.0-rc.5 when dsp actually requires 0.1.2-rc.1 contracts. | Raise to `">=0.1.2-rc.1"` and single-source it with the peerDeps range; the absence of any runtime host-version check is the systemic gap owned by slice F. |
| G-2 | **P1** | Undeclared host dependency | `src/settings-section.ts:25` imports `type { SettingsProvider } from '@deepseek-ai/dsh-settings'`; absent from `package.json` peerDependencies (lines 54-71) | dsp's settings integration depends on a host package it does not declare; a host rename/removal surfaces only as a typecheck failure in an unreleased state, and the runtime dependency is invisible in the manifest. | Add `"@deepseek-ai/dsh-settings": "^0.1.2-rc.1"` to peerDependencies (optional if genuinely optional). |
| G-3 | P2 | npm description is pre-v1.30 | `package.json:4` "cc_fs/session/acc_msm 等 9 工具 … ACC/CCE/Constraints/SKILL/Session 五块 … 0.1.0-rc" | User-visible on npm: wrong tool names, wrong tool count (9 → 10), wrong prompt structure (five blocks → Induction 8-block/9-physical). | Rewrite to v1.30 naming + Induction. |
| G-4 | P2 | README requirement + version line stale | `README.md:5,12,283` and `README.en.md:5,12,283`: "DSH 0.1.0-rc 及以上", "v1.30.0", "62 files / 895 tests" | Users are told a host floor three minor versions too low and a stale capability baseline (current: 0.1.2-rc.1, v1.30.5, 913 tests). | Sync both READMEs; add the version line to the release checklist. |
| G-5 | P2 | Manifest description version hint stale | `dsh.plugin.json:5` "适配 DSH 公开版（0.1.0-rc…）" | Same class as G-3/G-4 but inside the host-facing manifest. | Sync to 0.1.2-rc.1. |
| G-6 | P2 (resolved) | Client dependency declaration vs client imports | `package.json:47-52` `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-settings"]`; `src/client/index.ts:17-21` type-imports `dsh-client-ui-conversation`, `dsh-client-ui-settings`, `dsh-client-ui-renderer` | **Resolved by host evidence — no functional risk**: the host parses this field as a plain string array (`packages/client/modules/src/index.ts:210`) and documents it as *informational*: "Three declarations read like dependency edges and none is interchangeable: Cordis service `inject`, module-graph `external`, and `dsh.client.inject` — the informational package-name edges" (`packages/client/AGENTS.md:85`); "dsh.client.inject edges are informational" (`packages/client/ui-workspace/src/client/index.ts:57`). Not a load gate. | Optional hygiene: list the other two consumed client packages so the declared edge set matches reality. |
| G-7 | **P1 (process)** | Version/declaration guard covers only 3 files | `scripts/dsh-develop.ts` `version` subcommand checks `package.json` / `dsh.plugin.json` / `CHANGELOG.md` | The drift class that caused the v1.30.5 release friction (1.30.4/1.30.4/1.30.5) is guarded, but `engines`, `peerDependencies`, README version line, and both descriptions are NOT — which is why G-1/G-3/G-4/G-5 drifted unnoticed. | Extend the guard to assert: engines.dsh consistent with the peerDeps range; README(.en) version + test baseline lines contain the current version; descriptions contain the current tool set. |
| G-8 | P2 | Client host packages not declared as devDependencies (host policy deviation) | `src/client/*.ts(x)` type-import `@deepseek-ai/dsh-client-ui-{settings,conversation,renderer}`; `package.json:92-104` devDependencies contain none of them (they resolve through tsconfig `paths` into the host install) | The host's own policy puts client imports, type-only imports, module augmentations, `dsh.client.inject` and metadata-only peers **in `devDependencies`** (`packages/client/AGENTS.md:63`). dsp instead resolves them via `tsconfig` paths → the client type baseline silently follows whatever host build is on disk, which is exactly why the 0.1.2-rc.1 upgrade needed two rounds of tsconfig path fixes. No runtime risk (type-only, erased), but the type baseline is unpinned. | Declare them as devDependencies at the supported host version, or add a typecheck step that records which host build the client types resolved from. |
| G-9 | P2 | Build artifact path is non-idempotent (templates never land at the expected path) | root `package.json:27` `"build": "tsc … && cp -r src/templates dist/templates"`; on disk only `dist/templates/templates/acc-*/SKILL.md` exists (9 skills) — `dist/templates/acc-*/` does **not**; resolver `src/index.ts:21-23` first tries `join(dist, 'templates')` then falls back to `../src/templates` | `cp -r src/templates dist/templates` re-nests on every build (dst exists), so the first-choice path `dist/templates/<skill>` **never** resolves; the installer only works because of the fallback to `src/templates` (present in `files[]`, so tarball installs still work). The declared build output is a lie and the artifact tree accumulates garbage. | `rm -rf dist/templates && cp -r src/templates dist/templates` (or `cp -r src/templates/. dist/templates/`). |
| G-10 | P2 | Second package in the repo: divergent version line + stale skill list | root `package.json:2-5` `@shgroup/dsh-serenity-plugin` **v0.2.0** (private, installer CLI + skill bundle) vs plugin `hooks/dsh-serenity-hooks/package.json` **v1.30.5**; description lists **8** skills (`acc-serenity/acc-fs/acc-git/acc-msm/acc-session/acc-eap/acc-neat/acc-kit`) while `src/templates/` holds **9** (`acc-safe-mode` missing) | Two deliverables ship from one repo on unrelated version lines with no stated relationship, and the installer package's own description omits a skill it installs. Any release/verification claim must say *which* package it covers — a real ambiguity risk for the release checklist. | State the two-package relationship (installer version ≠ plugin version, or unify), and sync the skill list to `src/templates/`. |

## 4. Cross-cutting observation

Eight of ten findings share one defect shape: **a declaration exists in more than one place with no
single source of truth and no guard**. The version number was fixed (3-way guard, G-7), but the *contract*
declarations (host floor, host dependency set, tool set, capability description, test baseline, skill list,
build output path) were not — so they drifted silently. This is the declaration-layer twin of the runtime
host-contract problem the other slices are auditing.

## 5. Method & limits

- Read: plugin `package.json` (full), `dsh.plugin.json` (full), `tsdown.config.ts` (full), `src/invariant.ts`
  (full), `src/constants.ts` (full), `src/status.ts:1-50`, `src/index.ts` (full), root `package.json` (full);
  grep for tool registrations, peer deps, client imports, templates, and stale doc strings; host-source
  greps for `engines`, `dsh.client.inject`, plugin-load failure semantics.
- Not verified here: whether any future host version starts enforcing `engines.dsh` (G-1); whether
  `dsh.client.inject` should enumerate all consumed client packages (G-6 — informational today, confirmed).
- No source modified.
