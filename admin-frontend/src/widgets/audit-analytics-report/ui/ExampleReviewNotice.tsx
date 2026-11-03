import React from 'react';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { useDevMode } from '../../../entities/session/model/useDevMode';

type Reviews = NonNullable<AuditDetailItem['unifiedReport']>['exampleReviews'];
export function ExampleReviewNotice({ items }: { items?: Reviews }) {
  const { devMode } = useDevMode();
  const pending = items?.filter((item) => item.status !== 'pass') ?? [];
  if (!devMode || !pending.length) return null;
  return <details className="sa-call-report-block">
    <summary>Примеры требуют проверки: {pending.length}</summary>
    <p>Неполные примеры скрыты. Если смысловую проверку выполнить не удалось, пример не считается подтверждённым. Это проверка рекомендаций, а не дополнительный штраф менеджеру.</p>
    {pending.map((item) => <div key={item.turnIndex}>
      <strong>Реплика {item.turnIndex + 1}: {item.status === 'fail' ? 'пример не прошёл проверку' : 'нужна проверка'}</strong>
      <ul>{item.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </div>)}
  </details>;
}
