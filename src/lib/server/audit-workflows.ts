import { Buffer } from 'node:buffer';

const DEFAULT_MAX_WORKFLOW_FILE_BYTES = 512 * 1024;
export const MAX_WORKFLOW_REFERENCE_MATCHES = 200;

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
    actions.push({
      target: match[1],
      ref: match[2]
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
    references.push({
      workflow: match[1],
      ref: match[2]
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

  const decoded = Buffer.from(boundedBase64Content(file.content, byteLimit), 'base64');
  return decoded.subarray(0, byteLimit).toString('utf8');
}

export function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function normalizeByteLimit(maxBytes: number): number {
  return Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
}

function normalizeMatchLimit(maxMatches: number): number {
  return Number.isSafeInteger(maxMatches) && maxMatches > 0 ? maxMatches : 0;
}

function boundedBase64Content(content: string, maxBytes: number): string {
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  let encoded = '';

  for (let index = 0; index < content.length && encoded.length < maxEncodedChars; index += 1) {
    const char = content[index];
    if (char !== '\n' && char !== '\r') {
      encoded += char;
    }
  }

  return encoded;
}
