#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledCli = resolve(root, 'dist/cli/nullbuilder.js');
const cli = resolve(root, 'src/cli/nullbuilder.ts');
const args = existsSync(bundledCli)
  ? [bundledCli, ...process.argv.slice(2)]
  : ['--import', 'tsx', cli, ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
