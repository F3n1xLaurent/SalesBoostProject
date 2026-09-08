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
    Sentry.setUser(auth.status === 'authenticated' ? { id: auth.user.account.id } : null);
  }, [auth]);

  return null;
}
