import { describe, expect, it } from 'vitest';
import { productAnalyticsRoute } from '../../admin-frontend/src/shared/routing/adminRoutes';
describe('product analytics menu sections', () => {
  it.each([
    ['/holdings/company-123', 'companies', '/holdings/:id'],
    ['/companies/branch-123', 'branches', '/companies/:id'],
    ['/users/employee-123', 'employees', '/users/:id'],
    ['/autodealers/employee-123', 'employees', '/autodealers/:id'],
    ['/audits/call-123', 'audits', '/audits/:id'],
    ['/audits/batches/batch-123', 'audits', '/audits/batches/:id'],
    ['/call-settings/plans/plan-123', 'call_settings', '/call-settings/plans/:id'],
    ['/staff/trainer/session-123', 'trainer', '/staff/trainer/:id'],
    ['/train/session-123', 'trainer', '/train/:id'],
    ['/staff/profile', 'profile', '/staff/profile'],
    ['/dealer/team', 'employees', '/dealer/team'],
    ['/internal-analytics', 'internal_analytics', '/internal-analytics'],
  ])('maps %s to a stable section and removes entity ids', (path, section, template) => {
    expect(productAnalyticsRoute(path)).toEqual({ section, route_template: template });
  });
});
