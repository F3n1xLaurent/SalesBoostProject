import React, { useState } from 'react';
import { autoTestRunPath } from '../model/autoTestRunId';

export function RunIdentity({ id, compact = false, target = 'call_plan' }: { id: string; compact?: boolean; target?: 'call_plan' | 'trainer' }) {
  const [feedback, setFeedback] = useState('');
  async function copy(link: boolean) {
    try {
      const value = link ? new URL(autoTestRunPath(id, target), window.location.origin).href : id;
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setFeedback(link ? 'Ссылка скопирована' : 'ID скопирован');
    } catch { setFeedback('Не удалось скопировать. Выделите ID вручную или откройте ссылку.'); }
  }
  return <div className={`testing-run-identity${compact ? ' testing-run-identity--compact' : ''}`}>
    <span className="sa-meta">ID{!compact && ' проверки'}:</span><code>{id}</code>
    <button type="button" className="testing-text-button" aria-label={`Скопировать ID проверки ${id}`} onClick={() => void copy(false)}>Копировать ID</button>
    {!compact && <><button type="button" className="testing-text-button" onClick={() => void copy(true)}>Копировать ссылку</button><a href={autoTestRunPath(id, target)}>Ссылка на проверку</a></>}
    {feedback && <span className="sa-meta" role="status">{feedback}</span>}
  </div>;
}
