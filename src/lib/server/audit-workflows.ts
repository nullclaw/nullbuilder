import { Buffer } from 'node:buffer';
import { sanitizeText } from '../text-safety';
import { isSafePositiveInteger } from './number-safety';

const DEFAULT_MAX_WORKFLOW_FILE_BYTES = 512 * 1024;
export const MAX_WORKFLOW_REFERENCE_MATCHES = 200;
export const MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH = 128;

export type WorkflowActionUse = {
  target: string;
  ref: string;
};

export type NullbuilderWorkflowRef = {
  workflow: string;
  ref: string;
};

export type EncodedGitHubContent = {
  content?: string;
  encoding?: string;
};

export function findActionUses(
  content: string,
  maxMatches = MAX_WORKFLOW_REFERENCE_MATCHES
): WorkflowActionUse[] {
  const actions: WorkflowActionUse[] = [];
  const matchLimit = normalizeMatchLimit(maxMatches);
  const regex = /^\s*(?:-\s*)?uses:\s*['"]?([^@\s'"]+)@([^'"\s#]+)['"]?/gm;
  let match: RegExpExecArray | null;

  while (actions.length < matchLimit && (match = regex.exec(content)) !== null) {
    const target = safeWorkflowReferenceToken(match[1]);
    const ref = safeWorkflowReferenceToken(match[2]);
    if (!target || !ref) {
      continue;
    }

    actions.push({
      target,
      ref
    });
  }

  return actions;
}

export function findNullbuilderWorkflowRefs(
  content: string,
  maxMatches = MAX_WORKFLOW_REFERENCE_MATCHES
): NullbuilderWorkflowRef[] {
  const references: NullbuilderWorkflowRef[] = [];
  const matchLimit = normalizeMatchLimit(maxMatches);
  const regex = /nullclaw\/nullbuilder\/\.github\/workflows\/([^@\s'"]+)@([^'"\s#]+)/g;
  let match: RegExpExecArray | null;

  while (references.length < matchLimit && (match = regex.exec(content)) !== null) {
    const workflow = safeWorkflowReferenceToken(match[1]);
    const ref = safeWorkflowReferenceToken(match[2]);
    if (!workflow || !ref) {
      continue;
    }

    references.push({
      workflow,
      ref
    });
  }

  return references;
}

export function shouldRequireShaPin(target: string, ref: string): boolean {
  if (target.startsWith('./') || target.startsWith('docker://')) {
    return false;
  }

  if (target.startsWith('nullclaw/nullbuilder/.github/workflows/')) {
    return false;
  }

  return !/^[a-f0-9]{40}$/i.test(ref);
}

export function isMutableRef(ref: string): boolean {
  return ref === 'main' || ref === 'master' || ref.startsWith('refs/heads/');
}

export function decodeGitHubContent(
  file: EncodedGitHubContent,
  maxBytes = DEFAULT_MAX_WORKFLOW_FILE_BYTES
): string {
  if (file.encoding !== 'base64' || !file.content) {
    return '';
  }

  const byteLimit = normalizeByteLimit(maxBytes);
  if (byteLimit === 0) {
    return '';
  }

  const content = boundedBase64Content(file.content, byteLimit);
  if (!isStrictBase64Content(content)) {
    return '';
  }

  const decoded = Buffer.from(content, 'base64').subarray(0, byteLimit);
  return decodeUtf8WorkflowContent(decoded);
}

function normalizeByteLimit(maxBytes: number): number {
  return isSafePositiveInteger(maxBytes) ? maxBytes : 0;
}

function normalizeMatchLimit(maxMatches: number): number {
  return isSafePositiveInteger(maxMatches) ? maxMatches : 0;
}

function safeWorkflowReferenceToken(value: string): string {
  return sanitizeText(value, {
    maxLength: MAX_WORKFLOW_REFERENCE_TOKEN_LENGTH,
    trim: true
  });
}

function boundedBase64Content(content: string, maxBytes: number): string {
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;

  if (content.length <= maxEncodedChars && !/[\r\n]/.test(content)) {
    return content;
  }

  const chunks: string[] = [];
  let encodedLength = 0;
  let chunkStart = 0;

  for (let index = 0; index < content.length && encodedLength < maxEncodedChars; index += 1) {
    const char = content[index];
    if (char === '\n' || char === '\r') {
      if (chunkStart < index) {
        chunks.push(content.slice(chunkStart, index));
      }
      chunkStart = index + 1;
      continue;
    }

    encodedLength += 1;
    if (encodedLength === maxEncodedChars) {
      chunks.push(content.slice(chunkStart, index + 1));
      chunkStart = index + 1;
    }
  }

  if (encodedLength < maxEncodedChars && chunkStart < content.length) {
    chunks.push(content.slice(chunkStart));
  }

  return chunks.join('');
}

function isStrictBase64Content(content: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content);
}

function decodeUtf8WorkflowContent(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}
