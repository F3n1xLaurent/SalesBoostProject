import type { CallInsightDetail } from '../../model/call-insight/types';

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function scoreToColor(score: number | null) {
  const s = score == null || !Number.isFinite(score) ? 0 : clamp(score, 0, 100);
  // Согласовано с качественными зонами mock/оценки: красный / янтарный / зелёный.
  return s >= 70 ? '#22c55e' : s >= 55 ? '#f59e0b' : '#ef4444';
}

export function formatDurationSec(detail: CallInsightDetail): string {
  if (detail.durationSec != null) return `${detail.durationSec} сек`;
  if (detail.startedAt && detail.endedAt) {
    const sec = Math.max(
      0,
      Math.round((new Date(detail.endedAt).getTime() - new Date(detail.startedAt).getTime()) / 1000)
    );
    return `${sec} сек`;
  }
  return '—';
}

export function getCallQualityTag(
  detail: CallInsightDetail
): { text: string; tone: 'good' | 'mid' | 'bad' | 'neutral' } {
  if (detail.outcome === 'failed') return { text: 'Звонок не состоялся', tone: 'bad' };
  if (detail.processingError) return { text: 'Ошибка обработки', tone: 'bad' };
  if (detail.qualityTag && detail.qualityTag.trim()) {
    const t = detail.qualityTag.trim();
    const tl = t.toLowerCase();
    const tone: 'good' | 'mid' | 'bad' | 'neutral' =
      tl.includes('отлич') || tl.includes('хорош') ? 'good'
        : tl.includes('потенциал') || tl.includes('средне') ? 'mid'
          : tl.includes('улучш') || tl.includes('плохо') ? 'bad'
            : 'neutral';
    return { text: t, tone };
  }
  if (detail.totalScore == null) return { text: 'Нет оценки', tone: 'neutral' };
  const s = clamp(detail.totalScore, 0, 100);
  if (s >= 80) return { text: 'Хороший звонок', tone: 'good' };
  if (s >= 60) return { text: 'Есть потенциал', tone: 'mid' };
  return { text: 'Слабый звонок', tone: 'bad' };
}

export function priorityTone(raw?: string | null): 'high' | 'medium' | 'low' | 'unknown' {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s.includes('high') || s.includes('выс') || s.includes('крит')) return 'high';
  if (s.includes('medium') || s.includes('сред')) return 'medium';
  if (s.includes('low') || s.includes('низ')) return 'low';
  return 'unknown';
}

export type UiIndicator = { key: string; label: string; value: number | null };

export function buildIndicators(detail: CallInsightDetail): UiIndicator[] {
  const src = detail.dimensionScores || {};
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const to10 = (v: number | null) => (v == null ? null : v <= 1 ? v * 10 : v);
  return [
    { key: 'contact', label: 'Контакт', value: to10(pick(['контакт', 'rapport', 'contact'])) },
    { key: 'diagnosis', label: 'Диагностика', value: to10(pick(['диагностика', 'discovery', 'needs_discov' + 'ery'])) },
    { key: 'presentation', label: 'Презентация', value: to10(pick(['презентация', 'presentation', 'product_presentation'])) },
    { key: 'objections', label: 'Возражения', value: to10(pick(['возражения', 'objection_handling', 'objections'])) },
    { key: 'next', label: 'Следующий шаг', value: to10(pick(['следующий_шаг', 'closing', 'next_step'])) },
  ].map((x) => ({
    ...x,
    value: x.value == null ? null : clamp(x.value, 0, 10),
  }));
}

export function buildConversationPairs(detail: CallInsightDetail) {
  const pairs: Array<{ order: number; customerMessage: string; managerAnswer: string }> = [];
  const t = detail.transcript || [];
  let order = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i].role === 'client' && t[i + 1].role === 'manager') {
      order += 1;
      pairs.push({ order, customerMessage: t[i].text, managerAnswer: t[i + 1].text });
    }
  }
  return pairs;
}

export function inferFindingBlock(text: string): { key: 'contact' | 'diagnosis' | 'presentation' | 'objections' | 'next' | 'other'; label: string } {
  const s = String(text || '').toLowerCase();
  if (/(следующ|шаг|запис|тест-драйв|встреч|созвон|когда вам удобно|дата|время)/i.test(s)) {
    return { key: 'next', label: 'Следующий шаг' };
  }
  if (/(диагност|уточн|вопрос|потребност|бюджет|срок|кто принимает|комплектац|модель)/i.test(s)) {
    return { key: 'diagnosis', label: 'Диагностика' };
  }
  if (/(возраж|дорог|цена|стоим|подумаю|не сейчас)/i.test(s)) {
    return { key: 'objections', label: 'Возражения' };
  }
  if (/(презент|в наличии|услов|комплектац|гарант|акци|выгода|плюс|отлича)/i.test(s)) {
    return { key: 'presentation', label: 'Презентация' };
  }
  if (/(приветств|тон|вежлив|хам|перебил|слуша)/i.test(s)) {
    return { key: 'contact', label: 'Контакт' };
  }
  return { key: 'other', label: 'Прочее' };
}

export function inferFindingImportance(
  getIndicator10: { contact(): number | null; diagnosis(): number | null; presentation(): number | null; objections(): number | null; next(): number | null },
  blockKey: 'contact' | 'diagnosis' | 'presentation' | 'objections' | 'next' | 'other',
  text: string
): { tone: 'high' | 'medium' | 'low'; label: string } {
  const s = String(text || '').toLowerCase();
  const hasNeg = /(нет|не\s+был|не\s+зафикс|отсутств|провал|слаб|ошибк|не\s+отработ)/i.test(s);
  const indicator =
    blockKey === 'contact' ? getIndicator10.contact()
      : blockKey === 'diagnosis' ? getIndicator10.diagnosis()
        : blockKey === 'presentation' ? getIndicator10.presentation()
          : blockKey === 'objections' ? getIndicator10.objections()
            : blockKey === 'next' ? getIndicator10.next()
              : null;

  const v = indicator == null ? null : clamp(indicator, 0, 10);
  if (v != null) {
    if (v < 6) return { tone: 'high', label: 'Критично' };
    if (v < 8) return { tone: 'medium', label: 'Важно' };
    return { tone: hasNeg ? 'medium' : 'low', label: hasNeg ? 'Важно' : 'Можно улучшить' };
  }
  if (hasNeg) return { tone: 'medium', label: 'Важно' };
  return { tone: 'low', label: 'Можно улучшить' };
}
