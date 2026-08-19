import type { RecommendationResult, RecommendationSignal } from '../../api/adminPanel';
import { LetsIcon } from '../icons/LetsIcon';

const PROBLEM_TITLES: Record<string, string> = {
  NO_INTRO_COMPANY: 'Представление компании', NO_CLIENT_NAME: 'Обращение к клиенту по имени',
  WEAK_DIALOG_OPENING: 'Начало диалога', NO_NEEDS_DISCOVERY: 'Выявление потребностей',
  NO_KEY_PARAMS: 'Уточнение ключевых параметров', PRODUCT_MISINFORMATION: 'Корректность информации о продукте',
  WEAK_BENEFIT_PRESENTATION: 'Презентация выгод', NO_DIRECT_ANSWER: 'Прямые ответы на вопросы',
  WEAK_OBJECTION_HANDLING: 'Работа с возражениями', NO_NEXT_STEP: 'Предложение следующего шага',
  NO_CONCRETE_NEXT_STEP: 'Фиксация конкретного шага', PASSIVE_STYLE: 'Инициативность в диалоге',
  BAD_TONE: 'Тон общения', MONOLOGUE: 'Баланс диалога', INTERRUPTS_CLIENT: 'Умение слушать клиента',
  CRITICAL_VIOLATION: 'Критические нарушения',
};
const pct = (value?: number) => `${Math.round(value ?? 0)}%`;
const num = (value?: number) => Number(value ?? 0).toFixed(1).replace('.0', '');
const maybeEntity = (value?: string) => value?.trim() || undefined;

interface SignalCopy {
  entity?: string;
  title: string;
  reason: string;
  effect: string;
  action?: string;
}

function signalCopy(signal: RecommendationSignal): SignalCopy {
  const m = signal.metrics;
  if (signal.kind === 'checklist') {
    const label = PROBLEM_TITLES[signal.problemCode ?? ''] ?? signal.problemCode ?? 'Пункт чек-листа';
    const entity = signal.scope === 'quick' ? maybeEntity(signal.entityName) : undefined;
    const title = signal.scope === 'systemic' ? `${label} проседает системно` : label;
    const displayShare = entity && m.localizedProblemShare > 0 ? m.localizedProblemShare : m.problemShare;
    const reason = signal.scope === 'quick'
      ? entity
        ? `Проблема встречается в ${pct(displayShare)} звонков этой сущности, у остальных пункт чаще в норме.`
        : `Проблема встречается в ${pct(displayShare)} звонков за последние 30 дней.`
      : `Проблема встречается у ${Math.round(m.affectedChildren ?? 0)} из ${Math.round(m.totalChildren ?? 0)} сущностей и в среднем в ${pct(m.problemShare)} звонков.`;
    return {
      entity,
      title,
      reason,
      effect: signal.scope === 'systemic'
        ? `Может добавить около ${num(signal.importance)} балла группе, если закрепить стандарт у всех.`
        : `Может добавить около ${num(signal.importance)} балла при исправлении.`,
      action: entity ? 'Открыть профиль' : 'Открыть проверки',
    };
  }
  if (signal.kind === 'lagging') {
    return {
      entity: maybeEntity(signal.entityName),
      title: 'Тянет результат вниз',
      reason: `AI-рейтинг ${num(m.score)} против ${num(m.groupScore)} по группе — отставание ${num(m.delta)} балла.`,
      effect: `Может добавить около ${num(signal.importance)} балла, если подтянется до уровня группы.`,
      action: 'Открыть профиль',
    };
  }
  if (signal.kind === 'trend') {
    return {
      title: 'Результат снижается',
      reason: `AI-рейтинг упал с ${num(m.previousScore)} до ${num(m.currentScore)} за последний месяц.`,
      effect: 'Стоит проверить, что изменилось: команда, нагрузка, скрипт или сезонность.',
    };
  }
  if (signal.kind === 'source') {
    const entity = signal.scope === 'quick' ? maybeEntity(signal.entityName) : undefined;
    const sourceName = signal.sourceName ?? 'Источник';
    return {
      entity,
      title: signal.scope === 'systemic' ? `${sourceName} — слабое место группы` : `${sourceName} обрабатывается слабее`,
      reason: signal.scope === 'systemic'
        ? `У заметной части сущностей звонки с этого источника слабее остальных. AI-рейтинг ${num(m.score)} против ${num(m.otherScore)} по другим источникам.`
        : `AI-рейтинг ${num(m.score)} против ${num(m.otherScore)} по остальным источникам этой сущности.`,
      effect: `Может добавить около ${num(signal.importance)} балла, если подтянуть качество по этому источнику.`,
      action: signal.scope === 'systemic' ? 'Открыть аналитику' : 'Открыть проверки',
    };
  }
  if (signal.kind === 'missed') {
    const sourceName = signal.sourceName ?? (signal.phoneNumber ? `Номер ${signal.phoneNumber}` : null);
    return {
      entity: signal.scope === 'quick' ? maybeEntity(signal.entityName) : undefined,
      title: sourceName
        ? `${sourceName} плохо принимает звонки`
        : signal.ownership === 'dealership'
          ? 'Отдел продаж стабильно не берёт трубку'
          : 'Личный номер часто недоступен',
      reason: `${pct(m.missedRate)} звонков без ответа при норме не выше ${pct(m.allowedMissedRate)}. Проблема повторяется ${Math.round(m.badDays ?? 0)} дн. за неделю.`,
      effect: signal.scope === 'systemic'
        ? 'Похоже на проблему нагрузки, расписания или маршрутизации звонков.'
        : 'Стоит проверить линию, переадресацию и доступность номера.',
      action: signal.scope === 'systemic' ? 'Настроить обзвон' : 'Открыть проверки',
    };
  }
  return {
    entity: signal.scope === 'quick' ? maybeEntity(signal.entityName) : undefined,
    title: signal.ownership === 'dealership' ? 'Долго отвечают на звонки' : 'Слишком долго отвечают',
    reason: `В среднем ${num(m.answerTimeSec)} сек. до ответа при норме ${num(m.maximumAnswerTimeSec)} сек.`,
    effect: signal.scope === 'systemic'
      ? 'Клиенты могут не дождаться ответа, стоит пересмотреть нагрузку и организацию линии.'
      : 'Клиенты могут завершать звонок раньше, чем дождутся ответа.',
    action: 'Открыть проверки',
  };
}

function signalIcon(kind: string, scope: string): string {
  if (kind === 'lagging') return 'sort-down';
  if (kind === 'trend') return 'chart-alt-light';
  if (kind === 'source') return 'ring';
  if (kind === 'missed') return 'phone-light';
  if (kind === 'answer_speed') return 'time-atack';
  return scope === 'systemic' ? 'setting-line' : 'lightning-light';
}

function SignalCard({ signal, onOpen }: { signal: RecommendationSignal; onOpen?: (signal: RecommendationSignal) => void }) {
  const copy = signalCopy(signal);
  const clickable = Boolean(copy.action && onOpen);
  const iconName = signalIcon(signal.kind, signal.scope);
  const bonus = typeof signal.importance === 'number' && signal.importance > 0
    ? `+${num(signal.importance)}`
    : null;
  return (
    <article className={`sa-recommendation-insight${clickable ? ' is-clickable' : ''}`} onClick={clickable ? () => onOpen?.(signal) : undefined}>
      <div className="sa-recommendation-insight-head">
        <span className="sa-recommendation-insight-icon">
          <LetsIcon name={iconName} size={24} strokeWidth={1.5} />
        </span>
        <span className="sa-recommendation-insight-kind">
          {signal.scope === 'systemic' ? 'Системная' : 'Быстрая победа'}
        </span>
        {bonus && <span className="sa-recommendation-insight-bonus">{bonus}</span>}
      </div>
      <div className="sa-recommendation-insight-body">
        {copy.entity && <div className="sa-recommendation-insight-entity">{copy.entity}</div>}
        <h3 className="sa-recommendation-insight-title">{copy.title}</h3>
        <p className="sa-recommendation-insight-reason">{copy.reason}</p>
        {clickable && (
          <button type="button" className="sa-recommendation-insight-action" onClick={(event) => { event.stopPropagation(); onOpen?.(signal); }}>
            {copy.action} <LetsIcon name="arrow-right-long" size={14} />
          </button>
        )}
      </div>
    </article>
  );
}

export function RecommendationsBlock({ data, loading, error, onOpen }: { data: RecommendationResult | null; loading?: boolean; error?: string | null; onOpen?: (signal: RecommendationSignal) => void }) {
  if (loading) return <div className="sa-card sa-recommendation-state">Рассчитываем рекомендации…</div>;
  if (error) return <div className="sa-card sa-recommendation-state is-error">{error}</div>;
  if (!data) return null;
  if (data.state === 'insufficient_data') return <div className="sa-card sa-recommendation-state"><h3>Пока рано делать выводы</h3><p>Накоплено {data.evaluatedCalls} из минимум {data.minimumCalls} нужных проверок за 30 дней.</p></div>;
  if (data.state === 'normal') return <div className="sa-card sa-recommendation-state is-normal"><h3>Критичных проблем не обнаружено</h3><p>Результаты стабильны, значимых отклонений за последние 30 дней нет.</p>{data.growthPoint && <div className="sa-recommendation-growth"><strong>Точка роста:</strong> {signalCopy(data.growthPoint).title}. {signalCopy(data.growthPoint).effect}</div>}</div>;
  const all = [...data.quick, ...data.systemic];
  return (
    <div className="sa-recommendation-insights">
      {all.map((signal) => <SignalCard key={signal.id} signal={signal} onOpen={onOpen} />)}
    </div>
  );
}
