export type ScriptCriterionPromptItem = {
  expectedAnswer?: string;
  score?: number;
};

export type ScriptCriterionTranscriptTurn = {
  role: 'manager' | 'client' | string;
  text: string;
};

/**
 * Builds the semantic script-criteria prompt used after trainer sessions.
 * The reference answer is a minimum meaning, not a phrase-matching template.
 */
export function buildScriptCriteriaEvaluationPrompt(
  criteria: ScriptCriterionPromptItem[],
  transcript: ScriptCriterionTranscriptTurn[],
): string {
  return [
    'Ты оцениваешь разговор сотрудника с виртуальным клиентом по условиям успеха скрипта.',
    'Для каждого условия проверяй, передал ли сотрудник смысл эталонного ответа.',
    '',
    'КРИТИЧЕСКИЕ ПРАВИЛА СМЫСЛОВОЙ ОЦЕНКИ:',
    '- Эталон — это минимальный обязательный смысл, а не текст для буквального совпадения.',
    '- Развёрнутый ответ засчитывается полностью, если он содержит правильный смысл короткого эталона, даже если сформулирован другими словами, дополнен деталями или дан в другом порядке.',
    '- Не снижай балл только из-за длины ответа, перефразирования, вводных слов или дополнительной полезной информации.',
    '- Ищи выполнение условия во всём диалоге и во всех репликах сотрудника; смысл может быть раскрыт в нескольких последовательных репликах.',
    '- Снижай оценку только если обязательная часть смысла отсутствует, искажена, противоречит эталону либо ответ уходит от вопроса.',
    '- Полный смысл выполнен — полный балл; смысл выполнен частично — половина балла; смысл отсутствует или неверен — 0.',
    '- В evidence приведи короткую точную цитату сотрудника, которая подтверждает нужный смысл. Не требуй, чтобы вся длинная реплика совпадала с эталоном.',
    '- Верни ровно один item на каждое условие и скопируй expectedAnswer из условия без перефразирования.',
    '- score по каждому пункту НЕ МОЖЕТ быть больше maxScore этого пункта. Если maxScore=80, максимум score=80.',
    '- totalScore должен быть суммой score, maxScore должен быть суммой maxScore, percent = totalScore / maxScore * 100.',
    'Верни только JSON: {"items":[{"expectedAnswer":"...","maxScore":100,"score":0,"evidence":"цитата или причина"}],"totalScore":0,"maxScore":0,"percent":0}.',
    '',
    `Условия:\n${JSON.stringify(criteria, null, 2)}`,
    '',
    `Диалог:\n${transcript.map((turn) => `${turn.role === 'manager' ? 'Сотрудник' : 'Клиент'}: ${turn.text}`).join('\n')}`,
  ].join('\n');
}
