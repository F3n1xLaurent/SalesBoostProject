type TrainerSessionForDailyProgress = {
  status: string;
  startedAt: string;
  completedAt: string | null;
};

const MOSCOW_TIME_ZONE = 'Europe/Moscow';

function moscowDateKey(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function countTodayCompletedTrainings(
  sessions: TrainerSessionForDailyProgress[],
  now = new Date(),
): number {
  const today = moscowDateKey(now);
  if (!today) return 0;

  return sessions.filter((session) => (
    (session.status === 'completed' || session.status === 'failed')
    && moscowDateKey(session.completedAt || session.startedAt) === today
  )).length;
}
