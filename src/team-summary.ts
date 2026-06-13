import { openai } from './lib/openaiClient';
import { config } from './config';

export interface TeamSummaryData {
  totalAttempts: number;
  avgScore: number;
  levelCounts: {
    Junior: number;
    Middle: number;
    Senior: number;
  };
  topWeaknesses: Array<{ weakness: string; count: number }>;
  topStrengths: Array<{ strength: string; count: number }>;
  attempts: Array<{
    userName: string;
    score: number;
    level: string;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
  }>;
}

export async function generateExpertTeamSummary(data: TeamSummaryData): Promise<{
  executiveSummary: string;
  detailedAnalysis: string;
  keyFindings: Array<{ title: string; description: string; examples?: string[] }>;
  actionPlan: Array<{ priority: string; action: string; target: string; timeline: string }>;
  recommendations: string[];
}> {
  const prompt = `Ты эксперт-консультант по продажам с многолетним опытом. Проанализируй результаты тестирования команды менеджеров по продажам и создай детальную экспертную сводку.

Данные команды:
- Всего попыток: ${data.totalAttempts}
- Средний балл команды: ${data.avgScore.toFixed(1)}/100
- Распределение по уровням:
  * Junior: ${data.levelCounts.Junior} человек
  * Middle: ${data.levelCounts.Middle} человек
  * Senior: ${data.levelCounts.Senior} человек

Топ слабых сторон команды:
${data.topWeaknesses.map((w, i) => `${i + 1}. ${w.weakness} (встречается у ${w.count} сотрудников)`).join('\n')}

Топ сильных сторон команды:
${data.topStrengths.map((s, i) => `${i + 1}. ${s.strength} (встречается у ${s.count} сотрудников)`).join('\n')}

Детали по каждому сотруднику:
${data.attempts.map((a, i) => `
${i + 1}. ${a.userName} (${a.level}, ${a.score.toFixed(1)}/100)
   Сильные стороны: ${a.strengths.join(', ')}
   Слабые стороны: ${a.weaknesses.join(', ')}
`).join('\n')}

Создай экспертную сводку в следующем формате JSON:
{
  "executiveSummary": "<Краткое резюме на 2-3 предложения о текущем состоянии команды, ключевых проблемах и потенциале>",
  "detailedAnalysis": "<Детальный анализ на 4-6 абзацев: общая картина команды, анализ распределения по уровням, основные проблемы и их причины, сильные стороны команды, потенциал роста>",
  "keyFindings": [
    {
      "title": "<Название находки>",
      "description": "<Подробное описание находки с объяснением почему это важно>",
      "examples": ["<Конкретный пример 1>", "<Конкретный пример 2>"]
    }
  ],
  "actionPlan": [
    {
      "priority": "<Высокий/Средний/Низкий>",
      "action": "<Конкретное действие что нужно сделать>",
      "target": "<Для кого это действие (вся команда/Junior/Middle/Senior)>",
      "timeline": "<Срок выполнения: немедленно/в течение недели/в течение месяца>"
    }
  ],
  "recommendations": [
    "<Конкретная рекомендация 1 с объяснением>",
    "<Конкретная рекомендация 2 с объяснением>",
    "<Конкретная рекомендация 3 с объяснением>"
  ]
}

ВАЖНО:
- Все тексты должны быть ТОЛЬКО на РУССКОМ языке
- Будь конкретным и практичным - давай реальные рекомендации, которые можно применить
- Используй примеры из данных команды
- Укажи конкретные действия, а не общие фразы
- Сделай сводку полезной для принятия решений по развитию команды
- Детальный анализ должен быть информативным, но не слишком длинным (4-6 абзацев)`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [
        {
          role: 'system',
          content: 'Ты эксперт-консультант по продажам. Создавай детальные, практичные и полезные сводки по команде. Все тексты должны быть на РУССКОМ языке. Возвращай ТОЛЬКО валидный JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    console.error('Error generating expert summary:', error);
    throw error;
  }
}
