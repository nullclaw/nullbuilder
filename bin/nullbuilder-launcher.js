import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FORWARDED_ARG_COUNT = 128;
const MAX_FORWARDED_ARG_BYTES = 4096;
const MAX_FORWARDED_ARGS_TOTAL_BYTES = 128 * 1024;
const BIDI_FORMAT_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function resolveLauncherPaths(moduleUrl) {
  const root = resolve(dirname(fileURLToPath(moduleUrl)), '..');

  return {
    root,
    bundledCli: resolve(root, 'dist/cli/nullbuilder.js'),
    sourceCli: resolve(root, 'src/cli/nullbuilder.ts')
  };
}

export function buildChildArgs(paths, userArgs, bundledExists = existsSync(paths.bundledCli)) {
  if (!isSafeForwardedArgs(userArgs)) {
    return null;
  }

  return bundledExists
    ? [paths.bundledCli, ...userArgs]
    : ['--import', 'tsx', paths.sourceCli, ...userArgs];
}

export function runLauncher({
  argv = process.argv,
  cwd = process.cwd(),
  execPath = process.execPath,
  moduleUrl,
  stderr = process.stderr,
  spawn = spawnSync,
  exists = existsSync
}) {
  const paths = resolveLauncherPaths(moduleUrl);
  const childArgs = buildChildArgs(paths, argv.slice(2), exists(paths.bundledCli));

  if (!childArgs) {
    stderr.write('Invalid command arguments.\n');
    return 2;
  }

  const result = spawn(execPath, childArgs, {
    cwd,
    stdio: 'inherit'
  });

  if (result.error) {
    stderr.write('Failed to launch nullbuilder CLI.\n');
    return 1;
  }

  return result.status ?? 1;
}

function isSafeForwardedArgs(args) {
  if (args.length > MAX_FORWARDED_ARG_COUNT) {
    return false;
  }

  let totalBytes = 0;
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return false;
    }

    const bytes = Buffer.byteLength(arg);
    if (bytes > MAX_FORWARDED_ARG_BYTES || bytes > MAX_FORWARDED_ARGS_TOTAL_BYTES - totalBytes) {
      return false;
    }

    if (CONTROL_CHARACTER_PATTERN.test(arg) || BIDI_FORMAT_CONTROL_PATTERN.test(arg) || hasLoneSurrogate(arg)) {
      return false;
    }

    totalBytes += bytes;
  }

  return true;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!isLowSurrogate(nextCodeUnit)) {
        return true;
      }
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return true;
    }
  }

  return false;
}

function isHighSurrogate(value) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value) {
  return value >= 0xdc00 && value <= 0xdfff;
}
