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

export const DEFAULT_TRY_CLIENT_ID: TryClientId = 'sergey';

export function isTryClientId(value: string | null | undefined): value is TryClientId {
  return TRY_CLIENTS.some((client) => client.id === value);
}
