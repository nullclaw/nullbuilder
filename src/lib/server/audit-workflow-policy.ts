import type { AuditFinding } from './audit-types';
import type { AuditContext, AuditFindingBuilder } from './audit-rule-kit';
import {
  findActionUses,
  findNullbuilderWorkflowRefs,
  isMutableRef,
  shouldRequireShaPin
} from './audit-workflows';

const NULLBUILDER_WORKFLOWS = [
  { id: 'ci', file: 'zig-ci.yml', severity: 'warning' as const },
  { id: 'nightly', file: 'zig-nightly.yml', severity: 'info' as const },
  { id: 'release', file: 'zig-release.yml', severity: 'info' as const }
];

export function nullbuilderWorkflowFindings(
  context: AuditContext,
  finding: AuditFindingBuilder
): AuditFinding[] {
  if (context.workflowDirectory.status !== 'present') {
    return [
      finding(
        'warning',
        'Workflow directory is missing or unreadable',
        'Add .github/workflows entries for reusable nullbuilder CI and release automation.'
      )
    ];
  }

  return NULLBUILDER_WORKFLOWS.flatMap((workflow) => {
    const hasWorkflow = context.workflowFiles.some((file) =>
      file.content.includes(`nullclaw/nullbuilder/.github/workflows/${workflow.file}@`)
    );

    if (hasWorkflow) {
      return [];
    }

    return [
      finding(
        workflow.severity,
        `Missing nullbuilder ${workflow.id} workflow`,
        `Add a reusable workflow caller for ${workflow.file} when this repository should share nullbuilder automation.`
      )
    ];
  });
}

export function dangerousWorkflowTriggerFindings(
  context: AuditContext,
  finding: AuditFindingBuilder
): AuditFinding[] {
  return context.workflowFiles.flatMap((file) => {
    if (!/\bpull_request_target\b/.test(file.content)) {
      return [];
    }

    return [
      finding(
        'critical',
        'Workflow uses pull_request_target',
        `${file.path} can expose write-scoped tokens to untrusted pull request code unless every checkout and script path is locked down.`,
        file.url,
        file.path
      )
    ];
  });
}

export function workflowPermissionFindings(context: AuditContext, finding: AuditFindingBuilder): AuditFinding[] {
  return context.workflowFiles.flatMap((file) => {
    const findings: AuditFinding[] = [];

    if (/^\s*permissions:\s*write-all\s*$/m.test(file.content)) {
      findings.push(
        finding(
          'critical',
          'Workflow grants write-all permissions',
          `${file.path} should grant only the token scopes required by each job.`,
          file.url,
          file.path
        )
      );
    } else if (!/^\s*permissions:/m.test(file.content)) {
      findings.push(
        finding(
          'warning',
          'Workflow token permissions are implicit',
          `${file.path} should declare top-level or job-level permissions explicitly.`,
          file.url,
          file.path
        )
      );
    }

    if (/\bself-hosted\b/.test(file.content)) {
      findings.push(
        finding(
          'warning',
          'Workflow uses self-hosted runners',
          `${file.path} should treat self-hosted runners as privileged infrastructure and restrict untrusted events.`,
          file.url,
          file.path
        )
      );
    }

    return findings;
  });
}

export function workflowPinningFindings(context: AuditContext, finding: AuditFindingBuilder): AuditFinding[] {
  return context.workflowFiles.flatMap((file) => {
    const findings: AuditFinding[] = [];
    const usesLines = findActionUses(file.content);

    for (const action of usesLines) {
      if (!shouldRequireShaPin(action.target, action.ref)) {
        continue;
      }

      findings.push(
        finding(
          'warning',
          'Workflow action is not pinned to a commit SHA',
          `${file.path} uses ${action.target}@${action.ref}; pin third-party actions to immutable commits for stronger supply-chain guarantees.`,
          file.url,
          file.path
        )
      );
    }

    return findings.slice(0, 5);
  });
}

export function mutableNullbuilderWorkflowRefFindings(
  context: AuditContext,
  finding: AuditFindingBuilder
): AuditFinding[] {
  return context.workflowFiles.flatMap((file) => {
    const findings: AuditFinding[] = [];
    const references = findNullbuilderWorkflowRefs(file.content);

    for (const reference of references) {
      if (!isMutableRef(reference.ref)) {
        continue;
      }

      findings.push(
        finding(
          'warning',
          'Reusable workflow uses a mutable ref',
          `${file.path} references ${reference.workflow}@${reference.ref}; use a release tag for predictable cross-repository behavior.`,
          file.url,
          file.path
        )
      );
    }

    return findings;
  });
}
