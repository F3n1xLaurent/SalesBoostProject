import { openai } from '../lib/openaiClient';
import { config } from '../config';

export type CallSummaryFinding = { title: string; description: string; examples?: string[] };
export type CallSummaryAction = { priority: 'Высокий' | 'Средний' | 'Низкий'; action: string; target: string; timeline: string };

export type CallSummary = {
  executiveSummary: string;
  detailedAnalysis: string;
  keyFindings: CallSummaryFinding[];
  actionPlan: CallSummaryAction[];
};

export type ReplyImprovement = {
  order: number;
  customerMessage: string;
  managerAnswer: string;
  isOptimal: boolean;
  feedback: string;
  betterExample: string | null;
};

export function buildConversationPairs(
  transcript: Array<{ role: 'client' | 'manager'; text: string }>
): Array<{ order: number; customerMessage: string; managerAnswer: string }> {
  const pairs: Array<{ order: number; customerMessage: string; managerAnswer: string }> = [];
  let order = 0;
  let pendingCustomer: string | null = null;

  for (const turn of transcript) {
    const text = String(turn.text ?? '').trim();
    if (!text) continue;
    if (turn.role === 'client') {
      pendingCustomer = pendingCustomer ? `${pendingCustomer}\n${text}` : text;
      continue;
    }
    // manager
    if (!pendingCustomer) continue;
    order += 1;
    pairs.push({ order, customerMessage: pendingCustomer, managerAnswer: text });
    pendingCustomer = null;
  }

  return pairs;
}

export async function generateCallSummary(input: {
  transcript: Array<{ role: 'client' | 'manager'; text: string }>;
  outcome: string | null;
  totalScore: number | null;
  dimensionScores: Record<string, number> | null;
  issues: Array<{ issue_type?: string; recommendation?: string }>;
  checklist: Array<{ code: string; status: string; comment?: string }>;
  recommendations: string[];
}): Promise<CallSummary> {
  const turns = input.transcript.length;
  const pairs = buildConversationPairs(input.transcript);
  const transcriptStr = input.transcript
    .slice(0, 120)
    .map((m) => `${m.role === 'client' ? 'Клиент' : 'Менеджер'}: ${String(m.text).trim()}`)
    .join('\n');

  const prompt = `Ты — эксперт по продажам в автосалоне и наставник для менеджеров.
Проанализируй 1 звонок и верни ТОЛЬКО валидный JSON по схеме ниже. Все тексты — строго на русском.

Контекст звонка:
- Исход: ${input.outcome ?? '—'}
- Итоговый балл: ${input.totalScore ?? '—'}/100
- Реплик (всего): ${turns}
- Пар \"клиент→менеджер\": ${pairs.length}

Проблемы (issues):
${input.issues?.slice(0, 10).map((i, idx) => `${idx + 1}. ${(i.recommendation || i.issue_type || '').trim()}`).filter(Boolean).join('\n') || '—'}

Рекомендации оценщика:
${(input.recommendations || []).slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join('\n') || '—'}

Ключевые показатели (dimension_scores):
${input.dimensionScores ? Object.entries(input.dimensionScores).slice(0, 12).map(([k,v]) => `${k}: ${v}`).join('\n') : '—'}

Чеклист (top):
${(input.checklist || []).slice(0, 12).map((c) => `${c.code}: ${c.status}${c.comment ? ` — ${c.comment}` : ''}`).join('\n') || '—'}

Стенограмма (фрагмент):
${transcriptStr}

Требования к keyFindings:
- 3–6 пунктов. У каждого свой смысл: НЕ копируй одно и то же описание.
- description: конкретно, что произошло в ЭТОМ звонке и почему это важно (с отсылкой к чеклисту/issues/репликам). Запрещён шаблон вроде «блок не закрыт — снижает конверсию» без привязки к фактам.
- examples: по возможности короткие цитаты из стенограммы (на русском).

Требования к actionPlan:
- 3–5 шагов, формулировки как реальные задачи менеджеру/отделу («Записать клиента на…», «Отправить SMS с…», «Проговорить вилку…»).
- target: кратко зона (Контакт / Диагностика / Закрытие / Сервис / Процесс и т.п.).
- priority расставь по реальной критичности для ЭТОГО звонка (не ставь всем «Высокий» без причины).

Верни JSON СТРОГО в формате:
{
  \"executiveSummary\": \"<2-4 предложения: общий итог, главные проблемы и сильные стороны>\",
  \"detailedAnalysis\": \"<4-7 абзацев: структура разговора, качество выявления потребностей, презентация, работа с возражениями, следующий шаг, стиль коммуникации>\",
  \"keyFindings\": [
    {\"title\":\"<кратко>\",\"description\":\"<уникально для этого пункта>\",\"examples\":[\"<цитата из диалога>\"]}
  ],
  \"actionPlan\": [
    {\"priority\":\"Высокий|Средний|Низкий\",\"action\":\"<конкретное действие>\",\"target\":\"<зона>\",\"timeline\":\"<срок>\"}
  ]
}`;

  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      {
        role: 'system',
        content:
          'Ты эксперт по продажам. Все тексты строго на РУССКОМ языке. Верни ТОЛЬКО валидный JSON без лишних ключей.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.6,
    max_tokens: 1600,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenAI (call summary)');
  return JSON.parse(content) as CallSummary;
}

export async function generateReplyImprovements(input: {
  pairs: Array<{ order: number; customerMessage: string; managerAnswer: string }>;
  limit: number;
  issues: Array<{ issue_type?: string; recommendation?: string }>;
}): Promise<ReplyImprovement[]> {
  const pairsStr = input.pairs
    .slice(0, 60)
    .map((p) => `#${p.order}\nКлиент: ${p.customerMessage}\nМенеджер: ${p.managerAnswer}`)
    .join('\n\n');

  const prompt = `Ты — наставник по продажам в автосалоне.
Ниже пары реплик (клиент→менеджер). Твоя задача: выбрать не более ${input.limit} самых важных мест, где ответ менеджера НЕ оптимален, и предложить улучшение.

Требования:
- Все тексты строго на русском.
- Не придумывай факты. Улучшай ответ в рамках вопроса клиента.
- betterExample: 1–3 предложения, конкретно и по делу.
- feedback: 1 предложение, что именно не так/что упущено.
- isOptimal=true ставь только если ответ реально хороший (в этом случае betterExample=null и feedback=\"\").

Доп. контекст (issues от оценщика, если есть):
${input.issues?.slice(0, 8).map((i, idx) => `${idx + 1}. ${(i.recommendation || i.issue_type || '').trim()}`).filter(Boolean).join('\n') || '—'}

Пары:
${pairsStr}

Верни ТОЛЬКО JSON:
{
  \"replyImprovements\": [
    {
      \"order\": 1,
      \"customerMessage\": \"...\",
      \"managerAnswer\": \"...\",
      \"isOptimal\": false,
      \"feedback\": \"...\",\n      \"betterExample\": \"...\" \n    }
  ]
}`;

  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      {
        role: 'system',
        content:
          'Ты наставник по продажам. Все тексты строго на РУССКОМ языке. Верни ТОЛЬКО валидный JSON.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.5,
    max_tokens: 1800,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenAI (reply improvements)');
  const parsed = JSON.parse(content) as { replyImprovements?: ReplyImprovement[] };
  const items = Array.isArray(parsed.replyImprovements) ? parsed.replyImprovements : [];
  // Normalize minimal shape.
  return items
    .map((x) => ({
      order: Number((x as any).order) || 0,
      customerMessage: String((x as any).customerMessage ?? ''),
      managerAnswer: String((x as any).managerAnswer ?? ''),
      isOptimal: !!(x as any).isOptimal,
      feedback: String((x as any).feedback ?? ''),
      betterExample: (x as any).betterExample == null ? null : String((x as any).betterExample),
    }))
    .filter((x) => x.order > 0 && x.customerMessage.trim() && x.managerAnswer.trim());
}
