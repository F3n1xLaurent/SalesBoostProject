import { useEffect, useState } from 'react';

export const TRY_CLIENTS = [
  {
    id: 'mikhail',
    name: 'Михаил',
    temper: 'Спокойный и дотошный',
    colors: ['#FFDCA8', '#F58A1F'] as [string, string],
    ring: '#F79A33',
    seed: 41,
  },
  {
    id: 'sergey',
    name: 'Сергей',
    temper: 'Торопится и давит',
    colors: ['#FFFAC4', '#FBE81B'] as [string, string],
    ring: '#EFD525',
    seed: 2000,
  },
  {
    id: 'anna',
    name: 'Анна',
    temper: 'Сомневается и сравнивает',
    colors: ['#FFEFB6', '#FEB70D'] as [string, string],
    ring: '#FDBF2B',
    seed: 7,
  },
] as const;

export type TryClientId = typeof TRY_CLIENTS[number]['id'];
export type TryClient = Omit<typeof TRY_CLIENTS[number], 'name' | 'temper'> & { name: string; temper: string };

export const DEFAULT_TRY_CLIENT_ID: TryClientId = 'sergey';

export function isTryClientId(value: string | null | undefined): value is TryClientId {
  return TRY_CLIENTS.some((client) => client.id === value);
}

function loadPublicDemoClients(): Promise<TryClient[]> {
  return fetch('/api/public/demo-call/config', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { voices?: Array<{ id?: unknown; name?: unknown; description?: unknown }> };
      const byId = new Map((data.voices || []).map((voice) => [String(voice.id || ''), voice]));
      return TRY_CLIENTS.map((fallback): TryClient => {
        const remote = byId.get(fallback.id);
        return {
          ...fallback,
          name: typeof remote?.name === 'string' && remote.name.trim() ? remote.name.trim() : fallback.name,
          temper: typeof remote?.description === 'string' && remote.description.trim() ? remote.description.trim() : fallback.temper,
        };
      });
    })
    .catch(() => TRY_CLIENTS.map((client): TryClient => ({ ...client })));
}

export function useDemoClients(): TryClient[] {
  const [clients, setClients] = useState<TryClient[]>(() => TRY_CLIENTS.map((client) => ({ ...client })));
  useEffect(() => {
    let cancelled = false;
    void loadPublicDemoClients().then((items) => {
      if (!cancelled) setClients(items);
    });
    return () => { cancelled = true; };
  }, []);
  return clients;
}
