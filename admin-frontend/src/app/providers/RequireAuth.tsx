import type { ReactNode } from 'react';
import { useUnit } from 'effector-react';
import { Navigate, useLocation } from 'react-router';
import { $auth } from '../../entities/session';

export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useUnit($auth);
  const location = useLocation();

  if (auth.status === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f172a', color: '#fff' }}>
        Проверка сессии...
      </div>
    );
  }

  if (auth.status === 'guest') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
