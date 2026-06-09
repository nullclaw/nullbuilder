import type { AuditCheckResult, AuditFinding } from './audit-types';
import { evaluateAuditRule, isPresent, type AuditContext, type AuditRule } from './audit-rule-kit';
import {
  findActionUses,
  findNullbuilderWorkflowRefs,
  isMutableRef,
  shouldRequireShaPin
} from './audit-workflows';

export { isPresent };
export type {
  AuditContext,
  GitHubBranchProtection,
  GitHubContentFile,
  GitHubContentItem,
  GitHubRepositoryResponse,
  Probe,
  WorkflowFile
} from './audit-rule-kit';

const NULLBUILDER_WORKFLOWS = [
  { id: 'ci', file: 'zig-ci.yml', severity: 'warning' as const },
  { id: 'nightly', file: 'zig-nightly.yml', severity: 'info' as const },
  { id: 'release', file: 'zig-release.yml', severity: 'info' as const }
];

const RULES: AuditRule[] = [
  {
    id: 'repository-active',
    title: 'Repository is active',
    area: 'repository',
    evaluate: (context, finding) => {
      if (!context.repository.archived) {
        return [];
      }

      return [
        finding(
          'warning',
          'Archived repository',
          'Archived repositories are skipped by most operational workflows.'
        )
      ];
    }
  },
  {
    id: 'security-policy',
    title: 'Security policy exists',
    area: 'security',
    evaluate: (context, finding) => {
      if (isPresent(context.securityPolicy) || isPresent(context.githubSecurityPolicy)) {
        return [];
      }

      return [
        finding(
          'warning',
          'Missing security policy',
          'Add SECURITY.md so vulnerability reports have a stable intake path.'
        )
      ];
    }
  },
  {
    id: 'dependabot',
    title: 'Dependabot configuration exists',
    area: 'security',
    evaluate: (context, finding) => {
      if (isPresent(context.dependabot)) {
        return [];
      }

      return [
        finding(
          'warning',
          'Missing Dependabot configuration',
          'Add .github/dependabot.yml to keep actions and package dependencies current.'
        )
      ];
    }
  },
  {
    id: 'codeowners',
    title: 'Code owners exist',
    area: 'security',
    evaluate: (context, finding) => {
      if (isPresent(context.codeowners) || isPresent(context.githubCodeowners)) {
        return [];
      }

      return [
        finding(
          'info',
          'Missing CODEOWNERS',
          'Add CODEOWNERS when review ownership should be enforceable instead of implicit.'
        )
      ];
    }
  },
  {
    id: 'branch-protection',
    title: 'Default branch is protected',
    area: 'security',
    evaluate: (context, finding) => {
      if (context.branchProtection.status === 'present') {
        const findings: AuditFinding[] = [];
        const protection = context.branchProtection.data;

        if (!protection.required_status_checks) {
          findings.push(
            finding(
              'warning',
              'Default branch has no required status checks',
              `Require CI checks before merging into ${context.repository.default_branch}.`
            )
          );
        }

        if (!protection.required_pull_request_reviews) {
          findings.push(
            finding(
              'info',
              'Default branch has no required reviews',
              `Require pull request reviews before merging into ${context.repository.default_branch} when the repository is collaborative.`
            )
          );
        }

        return findings;
      }

      if (context.branchProtection.status === 'missing') {
        return [
          finding(
            'warning',
            'Default branch protection was not found',
            `Protect ${context.repository.default_branch} with required checks before broad automation writes to this repository.`
          )
        ];
      }

      return [
        finding(
          'info',
          'Default branch protection could not be verified',
          'GitHub did not allow reading branch protection with the current token.'
        )
      ];
    }
  },
  {
    id: 'nullbuilder-workflows',
    title: 'Nullbuilder workflows are installed',
    area: 'workflow',
    evaluate: (context, finding) => {
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
  },
  {
    id: 'workflow-dangerous-triggers',
    title: 'Workflows avoid dangerous triggers',
    area: 'workflow',
    evaluate: (context, finding) => {
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
  },
  {
    id: 'workflow-permissions',
    title: 'Workflow token permissions are explicit',
    area: 'workflow',
    evaluate: (context, finding) => {
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
  },
  {
    id: 'workflow-pinning',
    title: 'Third-party workflow actions are pinned',
    area: 'workflow',
    evaluate: (context, finding) => {
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
  },
  {
    id: 'nullbuilder-workflow-ref',
    title: 'Nullbuilder workflow references are stable',
    area: 'release',
    evaluate: (context, finding) => {
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
  }
];

export function evaluateAuditChecks(context: AuditContext): AuditCheckResult[] {
  return RULES.map((rule) => evaluateAuditRule(rule, context));
}
