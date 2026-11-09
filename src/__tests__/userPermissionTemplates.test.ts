import { describe, expect, it, vi } from 'vitest';
import { customUserRoleOptions, defaultPermissionTemplateId, resolveUserRole, selectedUserRole } from '../../admin-frontend/src/pages/users/model/permissionTemplates';
import { handleCreateUser, handleUpdateUser } from '../auth/userManagement';
import { prisma } from '../db';

const templates = [
  { id: 'manager-default', name: 'Менеджер автосалона', isSystem: true },
  { id: 'company-default', name: 'Администратор холдинга', isSystem: true },
  { id: 'custom-a', name: 'Руководитель КЦ', isSystem: false },
  { id: 'custom-b', name: 'Менеджер автосалона', isSystem: false },
];

describe('one employee role corresponds to one template', () => {
  it('adds custom templates to the role list without duplicating built-in templates', () => {
    expect(customUserRoleOptions(templates).map(item => item.value)).toEqual(['template:custom-a', 'template:custom-b']);
  });
  it('selects the real system default even if a custom template has the same name', () => {
    expect(defaultPermissionTemplateId('manager', [...templates].reverse())).toBe('manager-default');
  });
  it('reopens an employee with their custom role selected rather than the underlying scope role', () => {
    expect(selectedUserRole('holding_admin', ['custom-a'], templates)).toBe('template:custom-a');
    expect(selectedUserRole('manager', ['manager-default'], templates)).toBe('manager');
  });
  it('uses one custom template independently of company or dealership scope', () => {
    expect(resolveUserRole('template:custom-a', templates, 'holding_admin')).toEqual({ role: 'holding_admin', templateIds: ['custom-a'] });
    expect(resolveUserRole('template:custom-a', templates, 'manager')).toEqual({ role: 'manager', templateIds: ['custom-a'] });
  });
  it('replaces a custom assignment with the selected built-in role default', () => {
    expect(resolveUserRole('holding_admin', templates, 'manager')).toEqual({ role: 'holding_admin', templateIds: ['company-default'] });
  });
  it('supports clearing the role without retaining the previously selected template', () => {
    expect(resolveUserRole('', templates, 'manager')).toEqual({ role: '', templateIds: [] });
  });
  it('rejects unavailable templates and prevents treating system templates as custom roles', () => {
    expect(() => resolveUserRole('template:deleted', templates, 'manager')).toThrow('не найден');
    expect(() => resolveUserRole('template:manager-default', templates, 'manager')).toThrow('не найден');
  });
});

describe('user API rejects multiple permission template assignments', () => {
  it.each(['create', 'edit'] as const)('%s rejects multiple templates before any database mutation', async mode => {
    const write = vi.spyOn(prisma.account, 'create');
    const transaction = vi.spyOn(prisma, '$transaction');
    try {
      const req = { authAccount: { memberships: [{ role: 'platform_superadmin' }] },
        params: { accountId: 'employee-1' }, get: () => '', body: { templateIds: ['custom-a', 'custom-b'] } } as any;
      const res = { status: vi.fn(), json: vi.fn() } as any;
      res.status.mockReturnValue(res);
      await (mode === 'create' ? handleCreateUser : handleUpdateUser)(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Сотруднику можно назначить только один шаблон прав.' });
      expect(write).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});
