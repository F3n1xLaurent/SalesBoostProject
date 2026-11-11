import { ABANDON_AFTER_HOURS, DAY_MS, dayKey, mean, ratio, unique } from './config';
import type { Sources, Training, ActivityResponse, Event } from './types';
export function trainingOutcomes(trainings: Training[], now: Date) {
  const result = { evaluated: 0, failCase: 0, abandoned: 0, failed: 0 };
  for (const item of trainings) {
    if (item.status === 'completed')
      result[item.score === null ? 'failed' : 'evaluated']++;
    else if (item.status === 'failed')
      result[isBehavioralFailure(item.failureReason) ? 'failCase' : 'failed']++;
    else if (item.status === 'cancelled' || (['in_progress', 'paused'].includes(item.status) && now.getTime() - item.startedAt.getTime() > ABANDON_AFTER_HOURS * 3600000))
      result.abandoned++;
  }
  return result;
}
export function trainerMetrics(trainings: Training[], plans: Sources['plans'], streaks: Sources['streaks'], events: Event[], now: Date): ActivityResponse['trainer'] {
  const trainedPeople = unique(trainings.map(item => item.accountId));
  const trained = new Set(trainings.map(item => item.accountId));
  const today = dayKey(now), yesterday = dayKey(new Date(now.getTime() - DAY_MS));
  return {
    outcomes: trainingOutcomes(trainings, now),
    byType: { plan: trainings.filter(item => item.sessionType === 'plan').length, free: trainings.filter(item => item.sessionType === 'free').length },
    byDifficulty: { easy: trainings.filter(item => item.difficulty === 'easy').length, medium: trainings.filter(item => item.difficulty === 'medium').length, hard: trainings.filter(item => item.difficulty === 'hard').length },
    trainedPeople, perPerson: trainedPeople ? trainings.length / trainedPeople : null,
    dailyPlanCompletionRate: ratio(plans.filter(item => item.items.length > 0 && item.items.every(part => part.status === 'completed')).length, plans.length),
    streakPeople: unique(streaks.filter(item => item.current >= 2 && (item.date === today || item.date === yesterday)).map(item => item.accountId)),
    avgDurationSec: mean(trainings.filter(item => item.status === 'completed' && item.score !== null && item.durationSec !== null).map(item => item.durationSec!)),
    openedNotStarted: unique(events.filter(item => item.role === 'employee' && item.eventName === 'trainer_opened' && !trained.has(item.accountId)).map(item => item.accountId)),
  };
}
function isBehavioralFailure(reason: string | null) {
  return new Set(['PROFANITY', 'BAD_TONE', 'IGNORED_QUESTIONS', 'POOR_COMMUNICATION', 'REPEATED_LOW_EFFORT', 'REPEATED_LOW_QUALITY', 'DISENGAGEMENT', 'CRITICAL_EVASION', 'RUDE_LANGUAGE']).has((reason ?? '').split(':')[0].toUpperCase());
}
