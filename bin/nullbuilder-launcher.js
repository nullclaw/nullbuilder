import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FORWARDED_ARG_COUNT = 128;
const MAX_FORWARDED_ARG_BYTES = 4096;
const MAX_FORWARDED_ARGS_TOTAL_BYTES = 128 * 1024;
const MAX_SPAWN_BOUNDARY_BYTES = 4096;
const BIDI_FORMAT_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const BUFFER_BYTE_LENGTH = Buffer.byteLength.bind(Buffer);
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger.bind(Number);
const MATH_MAX = Math.max.bind(Math);

export function resolveLauncherPaths(moduleUrl) {
  const root = resolve(dirname(fileURLToPath(moduleUrl)), '..');

  return {
    root,
    bundledCli: resolve(root, 'dist/cli/nullbuilder.js'),
    sourceCli: resolve(root, 'src/cli/nullbuilder.ts')
  };
}

export function buildChildArgs(paths, userArgs, bundledExists) {
  const childCliPaths = readChildCliPaths(paths);
  const forwardedArgs = readSafeForwardedArgs(userArgs);
  if (childCliPaths === null || forwardedArgs === null) {
    return null;
  }

  if (!isSafeChildCliPath(childCliPaths.bundledCli) || !isSafeChildCliPath(childCliPaths.sourceCli)) {
    return null;
  }

  const useBundledCli = readBundledCliPreference(existsSync, childCliPaths.bundledCli, bundledExists);
  if (useBundledCli === null) {
    return null;
  }

  return useBundledCli
    ? prefixedArgs([childCliPaths.bundledCli], forwardedArgs)
    : prefixedArgs(['--import', 'tsx', childCliPaths.sourceCli], forwardedArgs);
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
  const paths = readLauncherPaths(moduleUrl);
  if (paths === null) {
    stderr.write('Invalid launcher environment.\n');
    return 2;
  }

  const userArgs = readArgTail(argv, 2);
  if (userArgs === null) {
    stderr.write('Invalid command arguments.\n');
    return 2;
  }

  const bundledExists = readBundledCliExists(exists, paths.bundledCli);
  if (bundledExists === null) {
    stderr.write('Invalid launcher environment.\n');
    return 2;
  }

  const childArgs = buildChildArgs(paths, userArgs, bundledExists);

  if (!childArgs) {
    stderr.write('Invalid command arguments.\n');
    return 2;
  }

  if (!isSafeSpawnExecutable(execPath) || !isSafeSpawnBoundaryText(cwd)) {
    stderr.write('Invalid launcher environment.\n');
    return 2;
  }

  const childStatus = runChildProcess(spawn, execPath, childArgs, cwd);
  if (childStatus === null) {
    stderr.write('Failed to launch nullbuilder CLI.\n');
    return 1;
  }

  return childStatus;
}

function readLauncherPaths(moduleUrl) {
  try {
    return resolveLauncherPaths(moduleUrl);
  } catch {
    return null;
  }
}

function readChildCliPaths(paths) {
  try {
    if (paths === null || typeof paths !== 'object') {
      return null;
    }

    return {
      bundledCli: paths.bundledCli,
      sourceCli: paths.sourceCli
    };
  } catch {
    return null;
  }
}

function readBundledCliPreference(exists, bundledCli, bundledExists) {
  if (bundledExists !== undefined) {
    return typeof bundledExists === 'boolean' ? bundledExists : null;
  }

  return readBundledCliExists(exists, bundledCli);
}

function readBundledCliExists(exists, bundledCli) {
  try {
    return exists(bundledCli) === true;
  } catch {
    return null;
  }
}

function runChildProcess(spawn, execPath, childArgs, cwd) {
  try {
    const result = spawn(execPath, childArgs, {
      cwd,
      stdio: 'inherit'
    });

    return readChildStatus(result);
  } catch {
    return null;
  }
}

function readChildStatus(result) {
  try {
    if (result === null || typeof result !== 'object') {
      return null;
    }

    if (result.error) {
      return null;
    }

    const status = result.status;
    if (status === null || status === undefined) {
      return 1;
    }

    return isExitStatus(status) ? status : null;
  } catch {
    return null;
  }
}

function isExitStatus(value) {
  return NUMBER_IS_SAFE_INTEGER(value) && value >= 0 && value <= 255;
}

function readSafeForwardedArgs(args) {
  const length = readRuntimeArrayLength(args);
  if (length === null) {
    return null;
  }

  if (length > MAX_FORWARDED_ARG_COUNT) {
    return null;
  }

  const forwardedArgs = [];
  let totalBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = readRuntimeArrayItem(args, index);
    if (!entry.ok) {
      return null;
    }

    const arg = entry.value;
    if (typeof arg !== 'string') {
      return null;
    }

    const bytes = BUFFER_BYTE_LENGTH(arg);
    if (
      bytes === 0 ||
      bytes > MAX_FORWARDED_ARG_BYTES ||
      !fitsTotalByteBudget(totalBytes, bytes, MAX_FORWARDED_ARGS_TOTAL_BYTES)
    ) {
      return null;
    }

    if (CONTROL_CHARACTER_PATTERN.test(arg) || BIDI_FORMAT_CONTROL_PATTERN.test(arg) || hasLoneSurrogate(arg)) {
      return null;
    }

    forwardedArgs[forwardedArgs.length] = arg;
    totalBytes += bytes;
  }

  return forwardedArgs;
}

function readArgTail(args, start) {
  const length = readRuntimeArrayLength(args);
  if (length === null || !NUMBER_IS_SAFE_INTEGER(start) || start < 0) {
    return null;
  }

  const tailLength = MATH_MAX(length - start, 0);
  if (tailLength > MAX_FORWARDED_ARG_COUNT) {
    return null;
  }

  const tail = [];
  for (let index = start; index < length; index += 1) {
    const entry = readRuntimeArrayItem(args, index);
    if (!entry.ok) {
      return null;
    }

    tail[tail.length] = entry.value;
  }

  return tail;
}

function readRuntimeArrayLength(value) {
  if (!isRuntimeArray(value)) {
    return null;
  }

  try {
    const length = value.length;
    return NUMBER_IS_SAFE_INTEGER(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

function readRuntimeArrayItem(values, index) {
  try {
    return { ok: true, value: values[index] };
  } catch {
    return { ok: false, value: null };
  }
}

function isRuntimeArray(value) {
  try {
    return ARRAY_IS_ARRAY(value);
  } catch {
    return false;
  }
}

function prefixedArgs(prefix, userArgs) {
  const args = [];
  for (let index = 0; index < prefix.length; index += 1) {
    args[args.length] = prefix[index];
  }
  for (let index = 0; index < userArgs.length; index += 1) {
    args[args.length] = userArgs[index];
  }

  return args;
}

function fitsTotalByteBudget(usedBytes, nextBytes, maxBytes) {
  if (!NUMBER_IS_SAFE_INTEGER(usedBytes) || !NUMBER_IS_SAFE_INTEGER(nextBytes) || !NUMBER_IS_SAFE_INTEGER(maxBytes)) {
    return false;
  }

  if (usedBytes < 0 || nextBytes < 0 || maxBytes < 0 || usedBytes > maxBytes) {
    return false;
  }

  return nextBytes <= maxBytes - usedBytes;
}

function isSafeChildCliPath(value) {
  return isSafeSpawnExecutable(value);
}

function isSafeSpawnExecutable(value) {
  return isSafeSpawnBoundaryText(value) && !value.startsWith('-');
}

function isSafeSpawnBoundaryText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  if (BUFFER_BYTE_LENGTH(value) > MAX_SPAWN_BOUNDARY_BYTES) {
    return false;
  }

  return !CONTROL_CHARACTER_PATTERN.test(value) && !BIDI_FORMAT_CONTROL_PATTERN.test(value) && !hasLoneSurrogate(value);
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
