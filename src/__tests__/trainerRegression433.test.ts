import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { trainerBuiltinSources } from '../testing/trainerBuiltinFixtures';
import { trainerManagerFixtureReply } from '../testing/trainerManagerFixture';
import { ensureTrainerFarewell, ensureTrainerProgressingReply, isTrainerWaitingReply } from '../trainer/trainerScenario';

describe('433b864f trainer regression (offline)', () => {
  it('supplies facts to the test manager without leaking them into the client legend', () => {
    const { source } = trainerBuiltinSources();
    const answer = (text: string) => trainerManagerFixtureReply(source, [{ role: 'client', text }])!;
    expect(answer('Этот автомобиль ещё в наличии?')).toContain('в наличии');
    expect(answer('Что известно об истории обслуживания и состоянии?')).toContain('заказ-наряды');
    expect(answer('Какая окончательная цена и есть ли обязательные доплаты?')).toContain('6 405 000');
    expect(answer('Можно приехать и проверить независимой диагностикой?')).toContain('18:00');
    expect(answer('Хорошо, жду.')).not.toContain('Уточню');
    const promptContext = source.context.scenario as { context: string };
    expect(promptContext.context).not.toContain('заказ-наряды'); expect(promptContext.context).not.toContain('18:00');
    expect((trainerBuiltinSources().femaleSource.context.scenario as { context: string }).context).toContain('лично ещё не осматривала');
    expect(trainerManagerFixtureReply({ ...source, context: {} }, [])).toBeNull();
  });
  it('detects each archived waiting variant without rejecting substantive replies', () => {
    for (const text of ['Хорошо, жду.', 'Понял, жду вашего ответа.', 'Ладно, жду.', 'Ясно, жду.']) expect(isTrainerWaitingReply(text)).toBe(true);
    for (const text of ['Хорошо, жду документы. А какая итоговая цена?', 'Жду на месте в 18:00.', 'Цена мне подходит.']) expect(isTrainerWaitingReply(text)).toBe(false);
  });
  it('allows one wait but breaks repeated waiting using the next unasked business question', () => {
    const questions = [{ text: 'Этот автомобиль ещё в наличии?' }, { text: 'Что известно об истории обслуживания и состоянии автомобиля?' }];
    const history = [{ role: 'client', text: questions[0].text }, { role: 'manager', text: 'Уточню.' }, { role: 'client', text: 'Хорошо, жду.' }];
    expect(ensureTrainerProgressingReply('Хорошо, жду.', [], questions, 'Уточню.')).toBe('Хорошо, жду.');
    expect(ensureTrainerProgressingReply('Ясно, жду.', history, questions, 'Пока уточняю.')).toContain(questions[1].text);
    expect(ensureTrainerProgressingReply('Ясно, жду.', history, questions, 'Вы можете подождать?')).toBe('Ясно, жду.');
  });
  it('ends naturally at the turn cap instead of persisting "Ясно, жду" as a completed dialogue', () => {
    const goodbye = ensureTrainerFarewell('Ясно, жду.', true, true);
    expect(goodbye).toContain('всего доброго'); expect(goodbye).not.toContain('жду');
    expect(ensureTrainerFarewell('Понял. Можно посмотреть машину?', true, true)).not.toContain('?');
    expect(ensureTrainerFarewell('Да, бюджет до шести миллионов.', true)).toContain('Да, бюджет до шести миллионов.');
    expect(ensureTrainerFarewell('Спасибо, до свидания.', true)).toBe('Спасибо, до свидания.');
    expect(ensureTrainerFarewell('Хорошо, жду.', false)).toBe('Хорошо, жду.');
  });
  it('keeps the staged commit before persistence and defers observed TTS until commit', () => {
    const source = readFileSync('src/server.ts', 'utf8');
    const turn = source.slice(source.indexOf('async function runTrainerSessionTurn('), source.indexOf('async function processTrainerVoiceMessage('));
    expect(turn.indexOf('params.turnControl?.assertCurrent();\n  const rawQuestions')).toBeLessThan(turn.indexOf("timer.measure('ttsMs'"));
    expect(turn.indexOf('params.turnControl?.commit()')).toBeLessThan(turn.indexOf("timer.measure('persistenceMs'"));
    expect(turn.indexOf('observedVoices.forEach')).toBeGreaterThan(turn.indexOf("timer.measure('persistenceMs'"));
    const ui = readFileSync('admin-frontend/src/pages/train/ui/TrainPage.tsx', 'utf8');
    expect(ui).toContain('if (data.superseded)'); expect(ui).toContain('Уточнить предыдущую реплику голосовым'); expect(ui).not.toContain('disabled={sending || leaving || !dialogReady}');
  });
});
