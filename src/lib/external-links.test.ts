import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = join(projectRoot, 'src');

test('blank target links explicitly isolate the opener', () => {
  const unsafeLinks: string[] = [];

  for (const file of svelteFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gs)) {
      const rel = /\brel="([^"]*)"/.exec(match[0])?.[1] ?? '';
      const relTokens = new Set(rel.split(/\s+/).filter(Boolean));

      if (!relTokens.has('noopener') || !relTokens.has('noreferrer')) {
        unsafeLinks.push(`${relative(projectRoot, file)}:${lineNumberAt(source, match.index ?? 0)}`);
      }
    }
  }

  assert.deepEqual(unsafeLinks, []);
});

function svelteFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...svelteFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.svelte')) {
      files.push(path);
    }
  }

  return files;
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}
