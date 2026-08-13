/**
 * tsdown.prepare.config.ts — consumer-side build for git installs (the
 * `prepare` script): transpile the Node half straight from src without tsc
 * project references or the sibling harness checkout (only dev machines and
 * CI have it). Types are NOT checked here — `pnpm run typecheck` owns that.
 *
 * Peer dependencies (@deepseek-ai/dsh-*, cordis) stay external: the hosting
 * dsh installation provides them at runtime. Relative imports are bundled.
 */
import type { UserConfig } from 'tsdown'

export default {
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  tsconfig: 'tsconfig.prepare.json',
} satisfies UserConfig
