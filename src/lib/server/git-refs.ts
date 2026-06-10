import { readSafeTextInput } from '../text-safety';

const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_GIT_REF_NAME_LENGTH = 255;
const MAX_GIT_REF_INPUT_LENGTH = 1024;
const UNSAFE_GIT_REF_NAME_PATTERN = /[\u0000-\u001f\u007f ~^:?*[\]\\]/;
const UTF8_ENCODER = new TextEncoder();

export function assertFullGitSha(value: unknown, label: string): string {
  if (!isFullGitSha(value)) {
    throw new Error(`Invalid ${label}.`);
  }

  return value;
}

export function isFullGitSha(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  return FULL_GIT_SHA_PATTERN.test(value);
}

export function sanitizeGitBranchName(value: unknown, label = 'branch'): string {
  const branchName = readSafeGitRefText(value, label);

  if (!isSafeGitBranchName(branchName)) {
    throw new Error(`Invalid ${label}.`);
  }

  return branchName;
}

export function safeGitBranchName(value: unknown, fallback: string): string {
  try {
    return sanitizeGitBranchName(value);
  } catch {
    return fallback;
  }
}

export function sanitizeGitTargetRef(value: unknown, label = 'target ref'): string {
  const targetRef = readSafeGitRefText(value, label);

  if (isFullGitSha(targetRef) || isSafeGitBranchName(targetRef)) {
    return targetRef;
  }

  throw new Error(`Invalid ${label}.`);
}

function readSafeGitRefText(value: unknown, label: string): string {
  const safeValue = readSafeTextInput(value, {
    maxLength: MAX_GIT_REF_INPUT_LENGTH,
    trim: true
  });
  if (!safeValue) {
    throw new Error(`Invalid ${label}.`);
  }

  return safeValue;
}

function isSafeGitBranchName(branchName: string): boolean {
  if (
    !branchName ||
    branchName.length > MAX_GIT_REF_NAME_LENGTH ||
    utf8ByteLength(branchName) > MAX_GIT_REF_NAME_LENGTH
  ) {
    return false;
  }

  if (
    branchName === '@' ||
    branchName.startsWith('refs/') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock') ||
    branchName.includes('//') ||
    branchName.includes('..') ||
    branchName.includes('@{') ||
    UNSAFE_GIT_REF_NAME_PATTERN.test(branchName)
  ) {
    return false;
  }

  return hasSafeGitBranchSegments(branchName);
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function hasSafeGitBranchSegments(branchName: string): boolean {
  let segmentStart = 0;

  for (let index = 0; index <= branchName.length; index += 1) {
    if (index !== branchName.length && branchName[index] !== '/') {
      continue;
    }

    if (!isSafeGitBranchSegment(branchName, segmentStart, index)) {
      return false;
    }
    segmentStart = index + 1;
  }

  return true;
}

function isSafeGitBranchSegment(branchName: string, start: number, end: number): boolean {
  return end > start && branchName[start] !== '.' && !branchName.endsWith('.lock', end);
}
