import { createEffect, createEvent, createStore, sample } from 'effector';
import { apiJson } from '../api/api';
import { clearStoredAuth, readStoredAuth, writeStoredAuth } from '../lib/storage';

export type FrontendRole = 'super' | 'company' | 'dealer' | 'staff';

export type AuthUser = {
  account: {
    id: string;
    email: string;
    displayName: string | null;
    status: string;
  };
  allowedRoles: FrontendRole[];
  defaultRole: FrontendRole;
  memberships: Array<{
    id: string;
    role: string;
    holdingId: string | null;
    dealershipId: string | null;
  }>;
};

type AuthState =
  | { status: 'checking'; token: string | null; user: null; error: null }
  | { status: 'guest'; token: null; user: null; error: string | null }
  | { status: 'authenticated'; token: string; user: AuthUser; error: null };

export const bootstrapAuth = createEvent();
export const logout = createEvent();
export const authUnauthorized = createEvent();

export const loginFx = createEffect(async (params: { email: string; password: string }) => {
  const payload = await apiJson<AuthUser & { token: string }>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  writeStoredAuth({ token: payload.token });
  return payload;
});

export const loadSessionFx = createEffect(async () => {
  const stored = readStoredAuth();
  if (!stored?.token) {
    throw new Error('NO_TOKEN');
  }
  const payload = await apiJson<AuthUser>('/api/auth/me');
  return { token: stored.token, user: payload };
});

export const $auth = createStore<AuthState>({
  status: 'checking',
  token: null,
  user: null,
  error: null,
})
  .on(loginFx.doneData, (_, payload) => ({
    status: 'authenticated',
    token: payload.token,
    user: {
      account: payload.account,
      allowedRoles: payload.allowedRoles,
      defaultRole: payload.defaultRole,
      memberships: payload.memberships,
    },
    error: null,
  }))
  .on(loadSessionFx.doneData, (_, payload) => ({
    status: 'authenticated',
    token: payload.token,
    user: payload.user,
    error: null,
  }))
  .on(loginFx.failData, (_, error) => ({
    status: 'guest',
    token: null,
    user: null,
    error: error.message || 'Не удалось выполнить вход.',
  }))
  .on(loadSessionFx.failData, (_, error) => ({
    status: 'guest',
    token: null,
    user: null,
    error: error.message === 'NO_TOKEN' ? null : (error.message || 'Сессия истекла.'),
  }))
  .on(logout, () => ({
    status: 'guest',
    token: null,
    user: null,
    error: null,
  }))
  .on(authUnauthorized, () => ({
    status: 'guest',
    token: null,
    user: null,
    error: 'Сессия истекла. Войдите снова.',
  }));

sample({
  clock: bootstrapAuth,
  target: loadSessionFx,
});

logout.watch(() => {
  clearStoredAuth();
});

authUnauthorized.watch(() => {
  clearStoredAuth();
});
