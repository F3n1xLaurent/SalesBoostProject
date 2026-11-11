export type DemoCallSearchRow = {
  id: number;
  callId: string;
  phone: string;
  ipAddress: string | null;
  startedAt: string;
  outcome: string;
  durationSec: number | null;
  totalScore: number | null;
  error: string | null;
  ivrDetected: boolean;
  ivrPath: string[];
};

const outcomeLabels: Record<string, string> = {
  completed: 'Завершён', disconnected: 'Завершён', no_answer: 'Нет ответа', busy: 'Занято',
  failed: 'Ошибка', error: 'Ошибка', processing: 'Обработка', cancelled: 'Отменён',
};
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();

export function parseDemoCallNumericId(query: string): number | null {
  const match = /^(?:#|call-)?(\d+)$/i.exec(query.trim());
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

/** Search the entire result set before the API applies its table row limit. */
export function filterDemoCalls<T extends DemoCallSearchRow>(rows: T[], query: string): T[] {
  const terms = normalize(query).split(' ').filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter(row => {
    const duration = row.durationSec == null ? '' : `${Math.floor(row.durationSec / 60)}:${String(row.durationSec % 60).padStart(2, '0')}`;
    const score = row.totalScore == null ? '' : `${row.totalScore} ${String(row.totalScore).replace('.', ',')} ${Math.round(row.totalScore)}/100`;
    const values = normalize([
      row.id, `#${row.id}`, `call-${row.id}`, row.callId,
      row.phone, row.phone.replace(/\D/g, ''), row.ipAddress ?? '',
      row.startedAt, dateFormatter.format(new Date(row.startedAt)),
      row.outcome, outcomeLabels[row.outcome] ?? '',
      row.durationSec ?? '', duration, score, row.error ?? '',
      row.ivrDetected ? `IVR ${row.ivrPath.join('-')} ${row.ivrPath.join(' ')}` : '',
    ].join(' '));
    return terms.every(term => values.includes(term));
  });
}
