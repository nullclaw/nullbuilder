import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsRoot = join(projectRoot, '.github', 'actions');

test('composite action Zig commands declare module dependencies explicitly', () => {
  const duplicateDependencies: string[] = [];

  for (const actionFile of actionYamlFiles(actionsRoot)) {
    const source = readFileSync(actionFile, 'utf8');
    if (!source.includes('zig run')) {
      continue;
    }

    const modules = zigRunModules(source);

    for (const [moduleName, dependencies] of modules) {
      const seen = new Set<string>();

      for (const dependency of dependencies) {
        if (seen.has(dependency)) {
          duplicateDependencies.push(`${relative(projectRoot, actionFile)}:${moduleName}:${dependency}`);
        }

        seen.add(dependency);
      }
    }

    assertDependencies(modules, 'root', ['action_args', 'action_paths', 'action_values']);
    assertDependencies(modules, 'action_args', ['action_text']);
    assertDependencies(modules, 'action_values', ['action_text']);
    assertDependencies(modules, 'action_text', ['text_safety']);
  }

  assert.deepEqual(duplicateDependencies, []);
});

test('setup-zig downloader keeps archive fetches on HTTPS', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');
  const curlLine = source.split('\n').find((line) => line.includes('curl ') && line.includes('"$archive_url"'));

  assert.ok(curlLine, 'setup-zig installer should fetch the resolved archive URL with curl');
  assert.match(curlLine, /--proto '=https'/);
  assert.match(curlLine, /--proto-redir '=https'/);
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

function zigRunModules(source: string): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  let pendingDependencies: string[] = [];

  for (const line of source.split('\n')) {
    const dependency = /^\s*--dep\s+([A-Za-z0-9_-]+)\s*\\?\s*$/.exec(line)?.[1];
    if (dependency) {
      pendingDependencies.push(dependency);
      continue;
    }

    const moduleName = /^\s*-M([A-Za-z0-9_-]+)=/.exec(line)?.[1];
    if (moduleName) {
      modules.set(moduleName, pendingDependencies);
      pendingDependencies = [];
    }
  }

  return modules;
}

function assertDependencies(modules: Map<string, string[]>, moduleName: string, expectedDependencies: string[]) {
  assert.deepEqual([...(modules.get(moduleName) ?? [])].sort(), [...expectedDependencies].sort());
}
