import React from 'react';

export function TranscriptionReviewNotice({ items }: { items?: Array<{ turnIndex: number; quote: string; reason: string }> }) {
  if (!items?.length) return null;
  return <aside className="sa-call-report-block" role="note" aria-label="Спорные фрагменты распознавания">
    <h2 className="sa-section-title">Нужно проверить запись</h2>
    <p>Эти фрагменты не считаются доказанной ошибкой менеджера. Исходная расшифровка сохранена.</p>
    {items.map((item, index) => <div key={`${item.turnIndex}-${index}`}>
      <strong>Реплика {item.turnIndex + 1}: «{item.quote}»</strong><p>{item.reason}</p>
    </div>)}
  </aside>;
}
