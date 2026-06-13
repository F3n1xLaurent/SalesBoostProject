import { openai } from './lib/openaiClient';
import { config } from './config';
import { EvaluationResult, EvaluationResultSchema } from './types';
import { prisma } from './db';

interface EvaluationInput {
  attemptId: number;
  steps: Array<{
    order: number;
    customerMessage: string;
    stepGoal: string;
    scoringFocus: string[];
    answer: string;
  }>;
}

export async function evaluateAttempt(input: EvaluationInput): Promise<EvaluationResult> {
  const prompt = buildEvaluationPrompt(input.steps);
  
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [
        {
          role: 'system',
          content: `Ты эксперт по оценке навыков продаж. Анализируй ответы менеджеров по продажам на сообщения клиентов и предоставляй структурированную оценку. 

КРИТИЧЕСКИ ВАЖНО: ВСЕ тексты в ответе ДОЛЖНЫ быть ТОЛЬКО на РУССКОМ языке. Это включает:
- Сильные стороны (strengths)
- Слабые стороны (weaknesses) 
- Рекомендации (recommendations)
- Обратную связь по каждому ответу (feedback)
- Примеры лучших ответов (better_example)
- Флаги подозрений (suspicion_flags)

НЕ используй английский язык ни в одном текстовом поле. Все формулировки должны быть на русском языке.

Возвращай ТОЛЬКО валидный JSON, соответствующий точной схеме.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      // Try to fix JSON with another LLM call
      console.error('JSON parse error, attempting fix...');
      const fixedResponse = await openai.chat.completions.create({
        model: config.openaiChatModel,
        messages: [
          {
            role: 'system',
            content: 'Исправь следующий JSON, чтобы он соответствовал точной схеме. ВСЕ тексты должны быть на РУССКОМ языке. Возвращай ТОЛЬКО исправленный JSON, без дополнительного текста.',
          },
          {
            role: 'user',
            content: `Исправь этот JSON:\n${content}`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const fixedContent = fixedResponse.choices[0]?.message?.content;
      if (!fixedContent) {
        throw new Error('Empty response from fix attempt');
      }

      parsed = JSON.parse(fixedContent);
    }

    const result = EvaluationResultSchema.parse(parsed);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Evaluation error:', errorMessage);
    
    // Store error in database
    await prisma.attempt.update({
      where: { id: input.attemptId },
      data: {
        evaluationError: errorMessage,
        status: 'completed',
        finishedAt: new Date(),
      },
    });

    throw error;
  }
}

function buildEvaluationPrompt(steps: EvaluationInput['steps']): string {
  const criteriaDescriptions = {
    STRUCTURE: 'Четкая структура, логичная последовательность, профессиональное оформление',
    NEEDS_DISCOVERY: 'Задает вопросы для понимания потребностей клиента, болевых точек и мотивации',
    EMPATHY_TONE: 'Проявляет эмпатию, понимание и поддерживает позитивный, дружелюбный тон',
    OBJECTION_HANDLING: 'Эффективно работает с возражениями и опасениями, переформулирует проблемы',
    VALUE_ARGUMENTATION: 'Четко представляет ценностное предложение, подчеркивает выгоды, релевантные клиенту',
    NEXT_STEP_CTA: 'Четко предлагает следующий шаг, создает срочность, упрощает процесс',
    RISK_PHRASES: 'Избегает агрессивного, навязчивого или манипулятивного языка, который может подорвать доверие',
  };

  let prompt = `Оцени ответы менеджера по продажам на диалоговый тест с клиентом. Сценарий: клиент интересуется покупкой автомобиля, у него есть опасения по поводу цены, альтернатив, доверия, и ему нужно записаться на следующий шаг.

Критерии оценки (балл 0-5 по каждому критерию):
${Object.entries(criteriaDescriptions).map(([code, desc]) => `- ${code}: ${desc}`).join('\n')}

Оценка:
- 0-1: Плохо/отсутствует
- 2-3: Базово/требует улучшения
- 4-5: Хорошо/отлично

Соответствие уровням:
- 0-39: Junior
- 40-69: Middle
- 70-100: Senior

Шаги диалога:\n\n`;

  steps.forEach((step, idx) => {
    prompt += `Шаг ${step.order}:\n`;
    prompt += `Клиент: "${step.customerMessage}"\n`;
    prompt += `Цель шага: ${step.stepGoal}\n`;
    prompt += `Фокус оценки: ${step.scoringFocus.join(', ')}\n`;
    prompt += `Ответ менеджера: "${step.answer}"\n\n`;
  });

  prompt += `\nВерни JSON со следующей точной структурой:
{
  "total_score": <число 0-100, среднее значение баллов по шагам>,
  "level": "<Junior|Middle|Senior>",
  "overall": {
    "strengths": ["<строка на русском языке>", ...],
    "weaknesses": ["<строка на русском языке>", ...],
    "recommendations": ["<строка на русском языке>", ...]
  },
  "steps": [
    {
      "step_order": <число>,
      "step_score": <число 0-100, нормализованное из баллов критериев>,
      "criteria": {
        "<КОД_КРИТЕРИЯ>": <число 0-5>,
        ...
      },
      "feedback": "<краткая обратная связь на русском языке>",
      "better_example": "<пример лучшего ответа на русском языке>"
    },
    ...
  ],
  "suspicion_flags": ["<строка на русском языке>", ...]
}

КРИТИЧЕСКИ ВАЖНО: 
- ВСЕ тексты в полях strengths, weaknesses, recommendations, feedback, better_example и suspicion_flags ДОЛЖНЫ быть ТОЛЬКО на РУССКОМ языке.
- НЕ используй английский язык ни в одном из этих полей.
- Все формулировки должны быть на русском языке.
- Примеры: вместо "Lack of detailed responses" пиши "Недостаточно детальных ответов", вместо "Good empathy" пиши "Хорошая эмпатия".

Оцени каждый шаг, используя только критерии из его scoring_focus. Рассчитай step_score как среднее значение баллов критериев * 20 (для нормализации 0-5 в 0-100).`;

  return prompt;
}
