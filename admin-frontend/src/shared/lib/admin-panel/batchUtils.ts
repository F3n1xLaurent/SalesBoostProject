import { apiFetch } from '../../../entities/session';

const API_BASE = '';

export const ACTIVE_BATCH_STORAGE_KEY = 'sa_active_call_batch_id_v1';

export type CallBatchSnapshot = {
  id: string;
  status: 'running' | 'paused' | 'cancelled' | 'completed';
  queuedJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryingJobs: number;
  totalJobs: number;
};

export type DealershipBatchSummary = {
  dealershipId: string | null;
  dealershipName: string;
  total: number;
  queued: number;
  inProgress: number;
  retrying: number;
  completed: number;
  failed: number;
  cancelled: number;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'partial';
};

type BatchApiResponse = {
  batch?: CallBatchSnapshot;
  dealershipSummary?: DealershipBatchSummary[];
};

export async function fetchBatchWithSummary(batchId: string): Promise<BatchApiResponse | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${batchId}`);
  if (!res.ok) {
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!data || !data.batch) {
    return null;
  }
  const batch = data.batch as CallBatchSnapshot;
  const summary = Array.isArray(data.dealershipSummary) ? (data.dealershipSummary as DealershipBatchSummary[]) : [];
  return { batch, dealershipSummary: summary };
}
