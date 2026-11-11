import { readCurrentStoredRole } from '../../entities/session/lib/roleStorage';
import { useEffect } from 'react';
import { useUnit } from 'effector-react';
import { $auth, authUnauthorized, bootstrapAuth } from '../../entities/session';
import { Sentry } from '../../shared/lib/monitoring/sentry';

export function AuthBootstrap() {
  const auth = useUnit($auth);

  useEffect(() => {
    bootstrapAuth();
    const onUnauthorized = () => authUnauthorized();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    const updateMonitoring = () => {
      Sentry.setUser(auth.status === 'authenticated' ? { id: auth.user.account.id } : null);
      const frontendRoles: Record<string,string> = { super:'platform_superadmin',company:'holding_admin',dealer:'dealership_admin',staff:'manager' };
      const activeRole = frontendRoles[readCurrentStoredRole() ?? ''];
      const memberships = auth.status === 'authenticated' ? auth.user.memberships : [];
      const membership = memberships.find(item => item.role === activeRole) ?? memberships[0];
      const roles: Record<string,string> = { platform_superadmin:'superadmin',holding_admin:'company_admin',dealership_admin:'branch_admin',manager:'employee' };
      Sentry.setTag('role', membership ? roles[membership.role] ?? 'unknown' : 'guest');
      Sentry.setTag('company_id', membership?.companyId ?? membership?.holdingId ?? 'none');
      Sentry.setTag('branch_id', membership?.dealershipId ?? 'none');
    };
    updateMonitoring();
    window.addEventListener('admin:role-changed', updateMonitoring);
    return () => window.removeEventListener('admin:role-changed', updateMonitoring);
  }, [auth]);

  return null;
}
