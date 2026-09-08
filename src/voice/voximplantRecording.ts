export interface VoximplantRecord {
  recordId: string;
  recordUrl: string;
}

export type VoxCallHistoryResponse = {
  result?: Array<{
    records?: Array<{ record_id?: number | string; record_url?: string }>;
  }>;
  error?: { msg?: string } | string;
};

export function findRecording(history: VoxCallHistoryResponse): VoximplantRecord | null {
  for (const session of history.result ?? []) {
    for (const record of session.records ?? []) {
      const recordId = String(record.record_id ?? '').trim();
      const recordUrl = String(record.record_url ?? '').trim();
      if (recordId && recordUrl) return { recordId, recordUrl };
    }
  }
  return null;
}
