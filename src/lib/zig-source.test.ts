import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('tui process exit stays outside managed resource scope', () => {
  const source = readFileSync(join(projectRoot, 'src', 'tui', 'main.zig'), 'utf8');
  const mainBody = functionBody(source, 'pub fn main');
  const runMainBody = functionBody(source, 'fn runMain');
  const runMainDebugBody = functionBody(source, 'fn runMainDebug');
  const runMainWithAllocatorBody = functionBody(source, 'fn runMainWithAllocator');

  assert.match(mainBody, /try runMain\(init\)/);
  assert.match(mainBody, /std\.process\.exit\(exit_code\)/);
  assert.match(runMainBody, /\.Debug => runMainDebug\(init\)/);
  assert.match(runMainBody, /else => runMainWithAllocator\(init, std\.heap\.smp_allocator\)/);
  assert.match(runMainDebugBody, /std\.heap\.DebugAllocator/);
  assert.match(runMainDebugBody, /defer std\.debug\.assert\(debug_allocator\.deinit\(\) == \.ok\);/);
  assert.match(runMainWithAllocatorBody, /defer threaded\.deinit\(\);/);
  assert.doesNotMatch(runMainBody, /std\.process\.exit/);
  assert.doesNotMatch(runMainDebugBody, /std\.process\.exit/);
  assert.doesNotMatch(runMainWithAllocatorBody, /std\.process\.exit/);
});

function functionBody(source: string, signature: string): string {
  const functionStart = source.indexOf(signature);
  assert.notEqual(functionStart, -1, `missing Zig function signature: ${signature}`);

  const bodyStart = source.indexOf('{', functionStart);
  assert.notEqual(bodyStart, -1, `missing Zig function body: ${signature}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`unterminated Zig function body: ${signature}`);
}
