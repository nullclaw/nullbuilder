import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsRoot = join(projectRoot, '.github', 'actions');

test('composite action Zig commands declare each dependency once', () => {
  const duplicateDependencies: string[] = [];

  for (const actionFile of actionYamlFiles(actionsRoot)) {
    const source = readFileSync(actionFile, 'utf8');
    const seen = new Set<string>();

    for (const dependency of zigRunDependencies(source)) {
      if (seen.has(dependency)) {
        duplicateDependencies.push(`${relative(projectRoot, actionFile)}:${dependency}`);
      }

      seen.add(dependency);
    }
  }

  assert.deepEqual(duplicateDependencies, []);
});

function actionYamlFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...actionYamlFiles(path));
    } else if (entry.isFile() && entry.name === 'action.yml') {
      files.push(path);
    }
  }

  return files;
}

function zigRunDependencies(source: string): string[] {
  return [...source.matchAll(/^\s*--dep\s+([A-Za-z0-9_-]+)\s*\\?\s*$/gm)].map((match) => match[1]);
}
