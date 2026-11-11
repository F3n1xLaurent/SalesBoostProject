import * as Sentry from '@sentry/node';
export function reportError(error: unknown, context: {
  task?: string;
  companyId?: string | null;
  branchId?: string | null;
  role?: string | null;
  stage?: string;
  entityId?: string;
} = {}) {
  console.error(`[${context.task ?? 'application'}]`, error instanceof Error ? error.message : error);
  Sentry.withScope(scope => {
    const tags = { task: context.task, company_id: context.companyId, branch_id: context.branchId, role: context.role, failure_stage: context.stage };
    for (const [key, value] of Object.entries(tags))
      if (value)
        scope.setTag(key, value);
    if (context.entityId)
      scope.setExtra('entity_id', context.entityId);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
