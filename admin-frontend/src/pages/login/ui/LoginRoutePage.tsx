import { useUnit } from 'effector-react';
import { Navigate, useLocation } from 'react-router';
import { $auth, LoginPage } from '../../../entities/session';

type LocationState = {
  from?: {
    pathname?: string;
    search?: string;
  };
};

export function LoginRoutePage() {
  const auth = useUnit($auth);
  const location = useLocation();
  const state = location.state as LocationState | null;
  const fromPath = state?.from?.pathname || '/dashboard';
  const fromSearch = state?.from?.search || '';

  if (auth.status === 'authenticated') {
    return <Navigate to={`${fromPath}${fromSearch}`} replace />;
  }

  return <LoginPage />;
}
