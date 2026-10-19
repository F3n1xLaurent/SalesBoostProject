import { describe, expect, it } from 'vitest';
import { buildSpokenNumberAnchors, normalizeRussianSpeechNumbers, russianNumberWords } from '../voice/speechFacts';
import { buildCustomerScenarioPromptCore, buildCallTargetLocationSection } from '../voice/customerScenarioPrompt';

describe('spoken facts in call and trainer prompts', () => {
  it('keeps millions and thousands in their correct place value', () => {
    expect(russianNumberWords(2_250_000)).toBe('два миллиона двести пятьдесят тысяч');
    expect(buildSpokenNumberAnchors('Цена 2 250 000 руб., диски 15 дюймов.')).toEqual([
      '2 250 000 руб. → два миллиона двести пятьдесят тысяч рублей',
      '15 дюймов → пятнадцать дюймов',
    ]);
    expect(normalizeRussianSpeechNumbers('Цена 2 250 000 руб., диски 15 дюймов.'))
      .toBe('Цена два миллиона двести пятьдесят тысяч рублей, диски пятнадцать дюймов.');
  });

  it('pins the called branch address and forbids another address', () => {
    const section = buildCallTargetLocationSection({ city: 'Москва', address: 'улица Ленина, 7' });
    expect(section).toContain('произноси только этот адрес: улица Ленина, 7');
    expect(section).toContain('Не используй адрес из описания компании');
  });

  it('gives both runtimes numeric and grammatical speech guidance', () => {
    for (const runtime of ['call', 'trainer'] as const) {
      const prompt = buildCustomerScenarioPromptCore({
        runtime,
        voiceName: 'Женский',
        itemDescription: 'Цена 2 250 000 руб. и колёса 15 дюймов.',
      });
      expect(prompt).toContain('два миллиона двести пятьдесят тысяч рублей');
      expect(prompt).toContain('пятнадцать дюймов');
      expect(prompt).toContain('женский голос — «поняла»');
      expect(prompt).toContain('а не «fifteen дюймов»');
    }
  });
});
