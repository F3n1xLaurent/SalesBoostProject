import type { RecommendationResult, RecommendationSignal } from '../../api/adminPanel';

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

function signalCopy(signal: RecommendationSignal) {
  const m = signal.metrics;
  if (signal.kind === 'checklist') {
    const label = PROBLEM_TITLES[signal.problemCode ?? ''] ?? signal.problemCode ?? 'Пункт чек-листа';
    return { title: signal.scope === 'quick' && signal.entityName ? `${signal.entityName}: ${label.toLowerCase()}` : signal.scope === 'systemic' ? `${label} требует системной работы` : `${label} — точка роста`, reason: signal.scope === 'quick' && signal.entityName ? `Проблема встречается в ${pct(m.localizedProblemShare)} звонков этой сущности, у большинства коллег пункт в норме.` : signal.scope === 'systemic' ? `Проблема встречается в ${pct(m.problemShare)} звонков; затрагивает ${m.affectedChildren ?? 0} из ${m.totalChildren ?? 0} сущностей группы.` : `Пункт выполняется примерно в ${pct(100 - (m.problemShare ?? 0))} случаев.`, effect: `Потенциальный прирост — около ${num(signal.importance)} балла.`, action: signal.scope === 'quick' && signal.entityName ? 'Открыть профиль' : 'Открыть проверки' };
  }
  if (signal.kind === 'lagging') return { title: `${signal.entityName ?? 'Сотрудник'} отстаёт от группы`, reason: `Средний балл ${num(m.score)} против ${num(m.groupScore)} по группе — отставание ${num(m.delta)}.`, effect: `При выравнивании группа может прибавить около ${num(signal.importance)} балла.`, action: 'Открыть профиль' };
  if (signal.kind === 'trend') return { title: 'Результат снижается', reason: `Средний балл упал с ${num(m.previousScore)} до ${num(m.currentScore)} за последний месяц.`, effect: 'Стоит проверить изменения в команде, скриптах и нагрузке.' };
  if (signal.kind === 'source') return { title: signal.scope === 'quick' && signal.entityName ? `${signal.entityName}: ${signal.sourceName ?? 'источник'} обрабатывается слабее` : `${signal.sourceName ?? 'Источник'} — слабое место группы`, reason: `Средний балл ${num(m.score)} против ${num(m.otherScore)} по остальным источникам.`, effect: `Потенциал улучшения — около ${num(signal.importance)} балла.`, action: signal.scope === 'systemic' ? 'Открыть аналитику' : 'Открыть проверки' };
  if (signal.kind === 'missed') return { title: signal.sourceName ? `${signal.sourceName} плохо принимает звонки` : signal.ownership === 'dealership' ? 'Отдел продаж стабильно не берёт трубку' : 'Личный номер часто недоступен', reason: `${pct(m.missedRate)} звонков без ответа при норме не выше ${pct(m.allowedMissedRate)}; повторяется ${m.badDays ?? 0} дня за неделю.`, effect: 'Проверьте загрузку линии, переадресацию и расписание.', action: signal.scope === 'systemic' ? 'Настроить обзвон' : 'Открыть проверки' };
  return { title: signal.ownership === 'dealership' ? 'Отдел продаж долго берёт трубку' : 'Сотрудник долго отвечает', reason: `В среднем ${num(m.answerTimeSec)} сек. до ответа при норме ${num(m.maximumAnswerTimeSec)} сек.`, effect: 'Клиенты могут завершать звонок до ответа.', action: 'Открыть проверки' };
}

function SignalCard({ signal, onOpen }: { signal: RecommendationSignal; onOpen?: (signal: RecommendationSignal) => void }) {
  const copy = signalCopy(signal);
  const clickable = Boolean(copy.action && onOpen);
  return <article className={`sa-recommendation-insight${clickable ? ' is-clickable' : ''}`} onClick={clickable ? () => onOpen?.(signal) : undefined}>
    <div className="sa-recommendation-insight-kind">{signal.scope === 'systemic' ? 'Системная работа' : 'Быстрая победа'}</div>
    <h3>{copy.title}</h3><p>{copy.reason}</p><div className="sa-recommendation-insight-effect">{copy.effect}</div>
    {clickable && <button type="button" className="sa-btn-text" onClick={(event) => { event.stopPropagation(); onOpen?.(signal); }}>{copy.action} →</button>}
  </article>;
}

export function RecommendationsBlock({ data, loading, error, onOpen }: { data: RecommendationResult | null; loading?: boolean; error?: string | null; onOpen?: (signal: RecommendationSignal) => void }) {
  if (loading) return <div className="sa-card sa-recommendation-state">Рассчитываем рекомендации…</div>;
  if (error) return <div className="sa-card sa-recommendation-state is-error">{error}</div>;
  if (!data) return null;
  if (data.state === 'insufficient_data') return <div className="sa-card sa-recommendation-state"><h3>Пока рано делать выводы</h3><p>Накоплено {data.evaluatedCalls} из минимум {data.minimumCalls} нужных проверок за 30 дней.</p></div>;
  if (data.state === 'normal') return <div className="sa-card sa-recommendation-state is-normal"><h3>Критичных проблем не обнаружено</h3><p>Результаты стабильны, значимых отклонений за последние 30 дней нет.</p>{data.growthPoint && <div className="sa-recommendation-growth"><strong>Точка роста:</strong> {signalCopy(data.growthPoint).title}. {signalCopy(data.growthPoint).effect}</div>}</div>;
  return <div className="sa-recommendation-sections">
    {data.quick.length > 0 && <div><h3 className="sa-card-heading">Что исправить сейчас</h3><div className="sa-recommendation-insights">{data.quick.map((signal) => <SignalCard key={signal.id} signal={signal} onOpen={onOpen} />)}</div></div>}
    {data.systemic.length > 0 && <div><h3 className="sa-card-heading">Над чем работать системно</h3><div className="sa-recommendation-insights">{data.systemic.map((signal) => <SignalCard key={signal.id} signal={signal} onOpen={onOpen} />)}</div></div>}
  </div>;
}
