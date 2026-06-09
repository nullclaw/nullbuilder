import { Buffer } from 'node:buffer';

const DEFAULT_MAX_WORKFLOW_FILE_BYTES = 512 * 1024;

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

export function findActionUses(content: string): WorkflowActionUse[] {
  const actions: WorkflowActionUse[] = [];
  const regex = /^\s*(?:-\s*)?uses:\s*['"]?([^@\s'"]+)@([^'"\s#]+)['"]?/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    actions.push({
      target: match[1],
      ref: match[2]
    });
  }

  return actions;
}

export function findNullbuilderWorkflowRefs(content: string): NullbuilderWorkflowRef[] {
  const references: NullbuilderWorkflowRef[] = [];
  const regex = /nullclaw\/nullbuilder\/\.github\/workflows\/([^@\s'"]+)@([^'"\s#]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
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

  const decoded = Buffer.from(file.content.replaceAll('\n', ''), 'base64');
  return decoded.subarray(0, maxBytes).toString('utf8');
}

export function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
