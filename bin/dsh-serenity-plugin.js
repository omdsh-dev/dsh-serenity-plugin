#!/usr/bin/env node
/**
 * dsh-serenity-plugin — CLI loader
 *
 * 优先用 bun（原生 TS 执行），否则 node + tsx。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');

let status;
if (process.env.BUN_INSTALL || process.execPath.includes('bun')) {
  status = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
} else {
  status = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
}
process.exit(status?.status ?? 1);
