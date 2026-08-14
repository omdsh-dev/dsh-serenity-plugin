/**
 * tsdown.prepare.config.ts — consumer-side build for git installs AND npm publish
 * (the `prepare` script). Must produce the FULL double bundle (Node half +
 * WebUI client half): npm publish runs `prepare`, and a Node-only prepare with
 * `clean: true` silently deleted lib/client.js from the published tarball
 * (v1.16.0/1.16.1 bug — dsh-client-modules then throws MissingClientBundleError
 * on activation). Reuse the same config as the dev build so `prepare` output
 * never diverges from `pnpm build`.
 *
 * Types are NOT checked here — `pnpm run typecheck` owns that.
 * Peer dependencies (@deepseek-ai/dsh-*, cordis) stay external: the hosting
 * dsh installation provides them at runtime. Relative imports are bundled.
 */
export { default } from './tsdown.config.js'
