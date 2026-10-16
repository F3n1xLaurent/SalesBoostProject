import { describe, it, expect } from 'vitest';
import { classifyBehavior, type BehaviorSignal } from '../logic/behaviorClassifier';

const normalCtx = { isClientWaitingAnswer: true };
const firstMsgCtx = { isClientWaitingAnswer: false };

describe('BehaviorClassifier', () => {
  describe('toxic detection', () => {
    it('detects profanity stems', () => {
      const r = classifyBehavior('Ну бля, я не знаю что вам сказать', normalCtx);
      expect(r.toxic).toBe(true);
      expect(r.severity).toBe('HIGH');
    });

    it('detects hostile phrases', () => {
      const r = classifyBehavior('Да отстань ты уже, надоел', normalCtx);
      expect(r.toxic).toBe(true);
    });

    it('detects "пошёл на" hostile pattern', () => {
      const r = classifyBehavior('Да пошёл ты, мне не до тебя', normalCtx);
      expect(r.toxic).toBe(true);
      expect(r.severity).toBe('HIGH');
    });

    it('does not flag clean professional message', () => {
      const r = classifyBehavior('Здравствуйте! Рад вас слышать, расскажу подробнее о комплектации.', normalCtx);
      expect(r.toxic).toBe(false);
      expect(r.severity).toBe('LOW');
    });

    it('does not mistake a detailed value argument for rude tone or disengagement', () => {
      const r = classifyBehavior(
        'Алексей, я вас прекрасно понимаю. На первый взгляд цена может казаться выше, но эта модель стоит каждого рубля. В ежедневных поездках она быстро себя окупит.',
        normalCtx,
      );
      expect(r.toxic).toBe(false);
      expect(r.disengaging).toBe(false);
      expect(r.severity).toBe('LOW');
    });
  });

  describe('low_effort detection', () => {
    it('detects very short answer', () => {
      const r = classifyBehavior('ок', normalCtx);
      expect(r.low_effort).toBe(true);
    });

    it('detects "хз"', () => {
      const r = classifyBehavior('хз', normalCtx);
      expect(r.low_effort).toBe(true);
    });

    it('detects "не знаю"', () => {
      const r = classifyBehavior('не знаю', normalCtx);
      expect(r.low_effort).toBe(true);
    });

    it('detects one-word filler "ладно"', () => {
      const r = classifyBehavior('ладно', normalCtx);
      expect(r.low_effort).toBe(true);
    });

    it('does not flag detailed answer', () => {
      const r = classifyBehavior(
        'Да, этот автомобиль в наличии. Chery Arrizo 8 2023 года, пробег 97 тысяч. Давайте расскажу подробнее о комплектации.',
        normalCtx
      );
      expect(r.low_effort).toBe(false);
    });
  });

  describe('evasion detection', () => {
    it('detects evasion when client is waiting and manager gives low effort', () => {
      const r = classifyBehavior('норм', { isClientWaitingAnswer: true });
      expect(r.evasion).toBe(true);
    });

    it('detects evasion with dismissive phrase', () => {
      const r = classifyBehavior('Не моя проблема, звоните куда-нибудь', { isClientWaitingAnswer: true });
      expect(r.evasion).toBe(true);
    });

    it('does not flag evasion on first message', () => {
      const r = classifyBehavior('ок', { isClientWaitingAnswer: false });
      expect(r.evasion).toBe(false);
    });
  });

  describe('prohibited phrase detection', () => {
    it('detects "посмотрите на сайте"', () => {
      const r = classifyBehavior('Все данные есть, посмотрите на сайте', normalCtx);
      expect(r.prohibited_phrase_hits).toContain('посмотрите на сайте');
    });

    it('detects "перезвоните"', () => {
      const r = classifyBehavior('Перезвоните попозже, я сейчас занят', normalCtx);
      expect(r.prohibited_phrase_hits).toContain('перезвоните');
    });

    it('detects "я не знаю"', () => {
      const r = classifyBehavior('Я не знаю, спросите у кого-нибудь ещё', normalCtx);
      expect(r.prohibited_phrase_hits).toContain('я не знаю');
    });

    it('detects dismissive "сами разбирайтесь"', () => {
      const r = classifyBehavior('Сами разбирайтесь, мне некогда', normalCtx);
      expect(r.prohibited_phrase_hits).toContain('сами разбирайтесь');
    });

    it('returns empty for clean message', () => {
      const r = classifyBehavior('Конечно, давайте расскажу подробнее. Этот автомобиль отлично подойдёт для города.', normalCtx);
      expect(r.prohibited_phrase_hits).toHaveLength(0);
    });
  });

  describe('severity levels', () => {
    it('HIGH for profanity', () => {
      expect(classifyBehavior('пиздец какой-то', normalCtx).severity).toBe('HIGH');
    });

    it('MEDIUM for dismissive + evasion combo', () => {
      const r = classifyBehavior('Не в курсе, сами разбирайтесь', { isClientWaitingAnswer: true });
      expect(r.severity).toBe('MEDIUM');
    });

    it('LOW for simple short answer without waiting context', () => {
      const r = classifyBehavior('да', firstMsgCtx);
      expect(r.severity).toBe('LOW');
    });
  });

  describe('disengagement', () => {
    it('does not treat a normal goodbye after a completed conversation as refusal', () => {
      const r = classifyBehavior('Спасибо, всего доброго!', normalCtx);
      expect(r.disengaging).toBe(false);
    });

    it('detects an explicit refusal to continue the conversation', () => {
      const r = classifyBehavior('Не хочу больше с вами разговаривать, давайте закончим.', normalCtx);
      expect(r.disengaging).toBe(true);
    });
  });

  describe('composite scenarios', () => {
    it('toxic + prohibited + low_effort all at once', () => {
      const r = classifyBehavior('бля, не знаю', { isClientWaitingAnswer: true });
      expect(r.toxic).toBe(true);
      expect(r.low_effort).toBe(true);
      expect(r.evasion).toBe(true);
      expect(r.severity).toBe('HIGH');
    });

    it('perfect professional message has no flags', () => {
      const r = classifyBehavior(
        'Добрый день! Меня зовут Алексей, автосалон АвтоМир. Да, Chery Arrizo 8 доступен. Какие у вас пожелания по комплектации?',
        normalCtx
      );
      expect(r.toxic).toBe(false);
      expect(r.low_effort).toBe(false);
      expect(r.evasion).toBe(false);
      expect(r.prohibited_phrase_hits).toHaveLength(0);
      expect(r.rationale).toBe('no issues detected');
    });
  });
});
