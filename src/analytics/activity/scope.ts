import type { Scope } from './types';
export class ActivityInputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function parseActivityScope(query: Record<string, unknown>): Scope {
  const period = query.period === undefined ? '30' : query.period;
  if (typeof period !== 'string' || !['7', '30', '90'].includes(period))
    throw new ActivityInputError('Период должен быть 7, 30 или 90 дней.');
  const id = (value: unknown) => {
    if (value === undefined)
      return null;
    if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value))
      throw new ActivityInputError('Некорректный идентификатор фильтра.');
    return value;
  };
  const companyId = id(query.companyId), branchId = id(query.branchId);
  if (branchId && !companyId)
    throw new ActivityInputError('Для выбора точки укажите компанию.');
  return { period: Number(period) as Scope['period'], companyId, branchId };
}
export const inScope = (item: {
  companyId: string;
  branchId?: string | null;
}, scope: Scope) => (!scope.companyId || item.companyId === scope.companyId) && (!scope.branchId || item.branchId === scope.branchId);
