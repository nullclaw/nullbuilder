import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsRoot = join(projectRoot, '.github', 'actions');
const workflowsRoot = join(projectRoot, '.github', 'workflows');

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

    assertActionHelperDependencies(modules);
  }

  assert.deepEqual(duplicateDependencies, []);
});

test('workflow Zig action tests declare module dependencies explicitly', () => {
  const source = readFileSync(join(workflowsRoot, 'ci.yml'), 'utf8');
  const modules = zigRunModules(source);

  assertActionHelperDependencies(modules);
});

test('setup-zig downloader keeps archive fetches on HTTPS', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');
  const curlLine = source.split('\n').find((line) => line.includes('curl ') && line.includes('"$archive_url"'));

  assert.ok(curlLine, 'setup-zig installer should fetch the resolved archive URL with curl');
  assert.match(curlLine, /--proto '=https'/);
  assert.match(curlLine, /--proto-redir '=https'/);
});

test('setup-zig metadata fetch is bounded and anchored', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');

  assert.match(source, /METADATA_URL = "https:\/\/ziglang\.org\/download\/index\.json"/);
  assert.match(source, /urllib\.request\.urlopen\(METADATA_URL, timeout=METADATA_TIMEOUT_SECONDS\)/);
  assert.match(source, /ensure_metadata_url\(response\.geturl\(\)\)/);
  assert.match(source, /response\.read\(MAX_METADATA_BYTES \+ 1\)/);
  assert.match(source, /json\.loads\(metadata\.decode\("utf-8"\)\)/);
});

test('setup-zig archive extraction requires the expected executable layout', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');

  assert.match(source, /top_level_entries = list\(destination\.iterdir\(\)\)/);
  assert.match(source, /len\(top_level_entries\) != 1 or not top_level_entries\[0\]\.is_dir\(\)/);
  assert.match(source, /find "\$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit/);
  assert.match(source, /\[ ! -x "\$\{extracted_dir\}\/\$\{zig_bin\}" \]/);
});

test('setup-zig cache paths reject multiline temp roots', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');

  assert.ok(source.includes('temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"'));
  assert.ok(source.includes('"" | -* | *$\'\\n\'* | *$\'\\r\'*)'));
  assert.ok(source.includes('tool_root="${temp_root}/nullbuilder-zig"'));
  assert.ok(source.includes('mktemp -d "${temp_root}/zig-archive.XXXXXX"'));
  assert.ok(source.includes('mktemp -d "${temp_root}/zig-extract.XXXXXX"'));
});

test('setup-zig validates archive filenames before local writes', () => {
  const source = readFileSync(join(actionsRoot, 'setup-zig', 'install-zig.sh'), 'utf8');

  assert.ok(source.includes('archive_name="${archive_url##*/}"'));
  assert.ok(source.includes('*..* | */* | *\\\\* | *$\'\\n\'* | *$\'\\r\'* | *[!A-Za-z0-9._+-]*'));
  assert.ok(source.includes('*.tar.xz | *.zip)'));
  assert.ok(source.includes('archive_path="${archive_dir}/${archive_name}"'));
});

test('nightly decide validates temp root before creating decision output files', () => {
  const source = readFileSync(join(actionsRoot, 'nightly-decide', 'action.yml'), 'utf8');

  assert.ok(source.includes('temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"'));
  assert.ok(source.includes('"" | -* | *$\'\\n\'* | *$\'\\r\'*)'));
  assert.ok(source.includes('decision_file="$(mktemp "${temp_root}/nightly-decision.XXXXXX")"'));
  assert.ok(!source.includes('mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nightly-decision.XXXXXX"'));
});

test('release workflow validates downloaded artifact targets before staging assets', () => {
  const source = readFileSync(join(workflowsRoot, 'zig-release.yml'), 'utf8');

  assert.ok(source.includes('target="${artifact_dir#${artifact_prefix}-}"'));
  assert.ok(source.includes('[[ ! "${target}" =~ ^[A-Za-z0-9._-]+$ ]]'));
  assert.ok(source.includes('[[ "${target}" == *..* ]]'));
  assert.ok(source.includes('invalid downloaded artifact target'));
});

test('workflow runner jobs bound execution time', () => {
  const missingTimeouts: string[] = [];

  for (const workflowFile of workflowYamlFiles(workflowsRoot)) {
    const source = readFileSync(workflowFile, 'utf8');

    for (const job of workflowJobs(source)) {
      const runsOn = job.lines.some((line) => /^\s{4}runs-on:\s+/.test(line));
      if (!runsOn) {
        continue;
      }

      const timeout = job.lines.some((line) => /^\s{4}timeout-minutes:\s+[1-9][0-9]*\s*$/.test(line));
      if (!timeout) {
        missingTimeouts.push(`${relative(projectRoot, workflowFile)}:${job.name}`);
      }
    }
  }

  assert.deepEqual(missingTimeouts, []);
});

test('workflow checkouts do not persist GitHub token credentials', () => {
  const persistentCredentials: string[] = [];

  for (const workflowFile of workflowYamlFiles(workflowsRoot)) {
    const lines = readFileSync(workflowFile, 'utf8').split('\n');

    for (const [index, line] of lines.entries()) {
      if (!line.includes('uses: actions/checkout@')) {
        continue;
      }

      const step = workflowStepBlock(lines, index);
      const disablesCredentialPersistence = step.some((stepLine) =>
        /^\s+persist-credentials:\s+false\s*$/.test(stepLine)
      );

      if (!disablesCredentialPersistence) {
        persistentCredentials.push(`${relative(projectRoot, workflowFile)}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(persistentCredentials, []);
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

function workflowYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function workflowJobs(source: string): { name: string; lines: string[] }[] {
  const lines = source.split('\n');
  const jobsStart = lines.findIndex((line) => line === 'jobs:');
  if (jobsStart === -1) {
    return [];
  }

  const jobs: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | undefined;

  for (const line of lines.slice(jobsStart + 1)) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      if (current) {
        jobs.push(current);
      }
      current = { name: jobMatch[1], lines: [line] };
      continue;
    }

    current?.lines.push(line);
  }

  if (current) {
    jobs.push(current);
  }

  return jobs;
}

function workflowStepBlock(lines: string[], startIndex: number): string[] {
  const block = [lines[startIndex]];
  const stepIndent = leadingWhitespaceLength(lines[startIndex]);

  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() === '') {
      block.push(line);
      continue;
    }

    const lineIndent = leadingWhitespaceLength(line);
    if (lineIndent === stepIndent && /^\s*-\s+/.test(line)) {
      break;
    }
    if (lineIndent < stepIndent) {
      break;
    }

    block.push(line);
  }

  return block;
}

function leadingWhitespaceLength(value: string): number {
  return value.length - value.trimStart().length;
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

function assertActionHelperDependencies(modules: Map<string, string[]>) {
  assertDependencies(modules, 'root', ['action_args', 'action_json', 'action_paths', 'action_values']);
  assertDependencies(modules, 'action_args', ['action_text']);
  assertDependencies(modules, 'action_json', ['action_values', 'json_fields']);
  assertDependencies(modules, 'json_fields', ['json_safety']);
  assertDependencies(modules, 'json_safety', ['text_safety']);
  assertDependencies(modules, 'action_paths', ['text_safety']);
  assertDependencies(modules, 'action_values', ['repository_safety', 'text_safety']);
  assertDependencies(modules, 'action_text', ['text_safety']);
  assertDependencies(modules, 'repository_safety', ['text_safety']);
}
