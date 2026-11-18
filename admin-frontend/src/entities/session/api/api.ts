import { clearStoredAuth, readStoredAuth } from '../lib/storage';
import { readCurrentStoredRole } from '../lib/roleStorage';

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const stored = readStoredAuth();
  const headers = new Headers(init?.headers || {});
  if (stored?.token) {
    headers.set('Authorization', `Bearer ${stored.token}`);
  }
  const currentRole = readCurrentStoredRole();
  if (currentRole) {
    headers.set('X-Admin-Role', currentRole);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  // An old request must not clear a different session opened in the meantime.
  const sameSession = Boolean(stored?.token && readStoredAuth()?.token === stored.token);
  if (response.status === 401 && sameSession) {
    clearStoredAuth();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
  }

  return response;
}

export async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || 'Ошибка запроса');
  }
  return data as T;
}
