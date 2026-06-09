import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/nullbuilder.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli/nullbuilder.js',
  banner: {
    js: '#!/usr/bin/env node'
  }
});
