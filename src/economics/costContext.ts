import { AsyncLocalStorage } from 'node:async_hooks';

export type CostContext = {
  entityType: 'voice_call' | 'trainer_session' | string;
  entityId: string;
  companyId?: string | null;
  stage?: string | null;
};

const storage = new AsyncLocalStorage<CostContext>();

export function withCostContext<T>(context: CostContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentCostContext(): CostContext | undefined {
  return storage.getStore();
}

