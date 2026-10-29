import { config } from '../config';
import { compatibleChatMaxTokens, compatibleChatTemperature, openai } from '../lib/openaiClient';

export type SemanticTurnDecision = {
  complete: boolean;
  confidence: number;
  reason: string;
};

export function parseSemanticTurnDecision(value: string): SemanticTurnDecision | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.complete !== 'boolean') return null;
    const confidence = Number(parsed.confidence);
    return {
      complete: parsed.complete,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      reason: String(parsed.reason ?? '').slice(0, 120),
    };
  } catch {
    return null;
  }
}

export async function assessSemanticTurnCompletion(input: {
  assistantQuestion: string;
  managerAnswer: string;
  timeoutMs: number;
}): Promise<SemanticTurnDecision | null> {
  if (!config.openaiApiKey || !input.managerAnswer.trim()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const completion = await openai.chat.completions.create({
      model: config.yandexRealtimeSemanticModel,
      ...compatibleChatTemperature(config.yandexRealtimeSemanticModel, 0),
      ...compatibleChatMaxTokens(config.yandexRealtimeSemanticModel, 90),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Ты определяешь конец хода в живом русском телефонном разговоре. ' +
            'complete=true только если собеседник закончил самостоятельную мысль и AI уже может отвечать, не перебивая вероятное продолжение. ' +
            'Пауза, длинный текст и точка ASR сами по себе не означают завершение. ' +
            'Если последняя часть выглядит как вводная конструкция, перечисление, пояснение, незаконченная причинно-следственная связь или подготовка к главному выводу — complete=false. ' +
            'Будь консервативен. Верни только JSON: {"complete":boolean,"confidence":number,"reason":"коротко"}.',
        },
        {
          role: 'user',
          content: `Предыдущая реплика AI:\n${input.assistantQuestion.slice(-1200)}\n\n` +
            `Текущий объединённый ответ менеджера:\n${input.managerAnswer.slice(-2400)}`,
        },
      ],
    }, { signal: controller.signal });
    return parseSemanticTurnDecision(completion.choices[0]?.message?.content ?? '');
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
