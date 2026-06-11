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
  AuditRule,
  WorkflowFile
} from './audit-rule-kit';

function auditRule(rule: AuditRule): AuditRule {
  return Object.freeze(rule);
}

const RULES: ReadonlyArray<AuditRule> = Object.freeze([
  auditRule({
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
  }),
  auditRule({
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
  }),
  auditRule({
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
  }),
  auditRule({
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
  }),
  auditRule({
    id: 'branch-protection',
    title: 'Default branch is protected',
    area: 'security',
    evaluate: (context, finding) => {
      if (context.branchProtection.status === 'present') {
        const findings: AuditFinding[] = [];
        const protection = context.branchProtection.data;

        if (!protection.required_status_checks) {
          findings[findings.length] = finding(
            'warning',
            'Default branch has no required status checks',
            `Require CI checks before merging into ${context.repository.default_branch}.`
          );
        }

        if (!protection.required_pull_request_reviews) {
          findings[findings.length] = finding(
            'info',
            'Default branch has no required reviews',
            `Require pull request reviews before merging into ${context.repository.default_branch} when the repository is collaborative.`
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
  }),
  auditRule({
    id: 'nullbuilder-workflows',
    title: 'Nullbuilder workflows are installed',
    area: 'workflow',
    evaluate: nullbuilderWorkflowFindings
  }),
  auditRule({
    id: 'workflow-dangerous-triggers',
    title: 'Workflows avoid dangerous triggers',
    area: 'workflow',
    evaluate: dangerousWorkflowTriggerFindings
  }),
  auditRule({
    id: 'workflow-permissions',
    title: 'Workflow token permissions are explicit',
    area: 'workflow',
    evaluate: workflowPermissionFindings
  }),
  auditRule({
    id: 'workflow-pinning',
    title: 'Third-party workflow actions are pinned',
    area: 'workflow',
    evaluate: workflowPinningFindings
  }),
  auditRule({
    id: 'nullbuilder-workflow-ref',
    title: 'Nullbuilder workflow references are stable',
    area: 'release',
    evaluate: mutableNullbuilderWorkflowRefFindings
  })
]);

export function auditRuleEntries(): ReadonlyArray<AuditRule> {
  return RULES;
}

export function evaluateAuditChecks(context: AuditContext): AuditCheckResult[] {
  const checks: AuditCheckResult[] = [];

  for (let index = 0; index < RULES.length; index += 1) {
    const rule = RULES[index];
    checks[checks.length] = evaluateAuditRule(rule, context);
  }

  return checks;
}
