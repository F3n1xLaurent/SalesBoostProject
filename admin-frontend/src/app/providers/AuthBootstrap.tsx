import { useEffect } from 'react';
import { authUnauthorized, bootstrapAuth } from '../../entities/session';

export function AuthBootstrap() {
  useEffect(() => {
    bootstrapAuth();
    const onUnauthorized = () => authUnauthorized();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  return null;
}
