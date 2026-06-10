import type { AuditCheckResult, AuditFinding } from './audit-types';
import { evaluateAuditRule, isPresent, type AuditContext, type AuditRule } from './audit-rule-kit';
import {
  dangerousWorkflowTriggerFindings,
  mutableNullbuilderWorkflowRefFindings,
  nullbuilderWorkflowFindings,
  workflowPermissionFindings,
  workflowPinningFindings
} from './audit-workflow-policy';

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

const RULES = [
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
    evaluate: nullbuilderWorkflowFindings
  },
  {
    id: 'workflow-dangerous-triggers',
    title: 'Workflows avoid dangerous triggers',
    area: 'workflow',
    evaluate: dangerousWorkflowTriggerFindings
  },
  {
    id: 'workflow-permissions',
    title: 'Workflow token permissions are explicit',
    area: 'workflow',
    evaluate: workflowPermissionFindings
  },
  {
    id: 'workflow-pinning',
    title: 'Third-party workflow actions are pinned',
    area: 'workflow',
    evaluate: workflowPinningFindings
  },
  {
    id: 'nullbuilder-workflow-ref',
    title: 'Nullbuilder workflow references are stable',
    area: 'release',
    evaluate: mutableNullbuilderWorkflowRefFindings
  }
] satisfies readonly AuditRule[];

export function evaluateAuditChecks(context: AuditContext): AuditCheckResult[] {
  const checks: AuditCheckResult[] = [];

  for (const rule of RULES) {
    checks.push(evaluateAuditRule(rule, context));
  }

  return checks;
}
