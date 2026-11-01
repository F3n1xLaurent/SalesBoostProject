import type { TrainerTestSource } from './trainerAutoTesting';

export const TRAINER_BUILTIN_SUITE_ID = 'trainer-builtin-v1';
export const TRAINER_BUILTIN_VERSION = '2026-10-30.2';
export type TrainerBuiltinVoice = { id: string; name: string; elevenLabsCode: string | null; openaiCode: string | null };
export const isTrainerBuiltinSource = (id: string) => [TRAINER_BUILTIN_SUITE_ID, 'trainer-builtin-female-v1', 'trainer-builtin-talkative-v1'].includes(id);

/** Fixed test data, not a copy of an employee's training or a production customer. */
export function trainerBuiltinSources(voices: TrainerBuiltinVoice[] = []) {
  function source(kind: 'skeptic' | 'female' | 'talkative'): TrainerTestSource {
    const female = kind === 'female';
    const name = female ? 'Мария' : kind === 'talkative' ? 'Олег' : 'Андрей';
    const profileName = female ? 'Сомневающаяся' : kind === 'talkative' ? 'Болтун' : 'Скептик';
    const fallbackVoice = female ? 'nova' : 'onyx';
    const gender = female ? /женск|женщин/u : /мужск|мужчин/u;
    // ElevenLabs IDs belong to the account: resolve matching catalog entries automatically.
    // If absent, use the existing trainer's explicit male/female OpenAI presets.
    const candidates = [...voices].sort((a, b) => a.id.localeCompare(b.id));
    const voice = candidates.find((item) => item.openaiCode === fallbackVoice) ?? candidates.find((item) => gender.test(item.name.toLowerCase()));
    const car = { id: 'builtin-gle-2023', title: 'Mercedes-Benz GLE 2023 года', brand: 'Mercedes-Benz', model: 'GLE', year: 2023, price_rub: 6405000, mileage_km: 18000,
      technical: { engine: 'бензин', transmission: 'автомат', drive: 'полный' }, description: { condition: 'По объявлению без ДТП; состояние нужно уточнить у менеджера.' },
      deal_terms: { price_rub: 6405000, extra_payments: 'Неизвестны — уточнить' }, location: { city: 'Москва' } };
    const legend = `Тебя зовут ${name}. Ты ${female ? 'женщина, говори о себе в женском роде' : 'мужчина, говори о себе в мужском роде'}, тебе 35 лет. Живёшь в Москве. Ищешь Mercedes-Benz GLE 2023 года, бюджет до 6 500 000 рублей, покупка в течение месяца. Автомобиль видел${female ? 'а' : ''} только в объявлении, лично ещё не осматривал${female ? 'а' : ''}. Сейчас у тебя Toyota Camry 2018 года, автомобиль на обмен рассматриваешь, но ещё не решил${female ? 'а' : ''}. Предпочитаешь оплату собственными средствами, кредит не планируешь. Детей двое. Если спрашивают о других неизвестных фактах, не выдумывай их. В объявлении цена 6 405 000 рублей, пробег 18 000 километров; это данные объявления, сведения менеджера проверяй и уточняй, а не считай заранее доказанными.`;
    const context = {
      seed: `builtin-${TRAINER_BUILTIN_VERSION}-${kind}`, mode: 'free', difficulty: 'medium', clientType: profileName,
      clientProfile: { id: `builtin-${kind}`, name: profileName, age: 35, city: 'Москва', voiceId: voice?.id ?? fallbackVoice,
        voiceName: `${female ? 'Женский' : 'Мужской'} голос${voice ? ` · ${voice.name}` : ` · ${fallbackVoice}`}`,
        elevenLabsVoiceId: voice?.elevenLabsCode ?? null, openaiVoiceId: voice?.openaiCode ?? fallbackVoice,
        temperament: female ? 'сомневающаяся, осторожная, ищет подтверждения и поддержку' : kind === 'talkative' ? 'разговорчивый, иногда отвлекается, но сохраняет цель покупки' : 'скептичный, проверяет факты, вежливо просит конкретику',
        patience: 'среднее', replyLength: kind === 'talkative' ? '2–4 естественных предложения' : '1–3 естественных предложения',
        communicationStyle: female ? 'Вежливый разговорный стиль; выражай сомнения, не соглашайся автоматически.' : kind === 'talkative' ? 'Живой разговорный стиль, иногда короткое отступление; не теряй нить и не отвечай за менеджера.' : 'Спокойно, предметно, с уместным недоверием к неподтверждённым обещаниям.' },
      company: { id: null, name: 'Тестовый автосалон', city: 'Москва', description: 'Вымышленный автосалон для изолированного автотеста, не реальная организация.' },
      scenario: { id: 'builtin-car-purchase-v1', name: 'Покупка автомобиля', context: legend,
        questions: [{ text: 'Этот автомобиль ещё в наличии?', required: true }, { text: 'Что известно об истории обслуживания и состоянии автомобиля?', required: true }, { text: 'Какая окончательная цена и есть ли обязательные доплаты?', required: true }, { text: 'Можно ли приехать на осмотр и проверить автомобиль независимой диагностикой?', required: true }],
        objections: [{ phrase: 'Сомневаюсь, что состояние соответствует объявлению. Чем это можно подтвердить?', whenAppropriate: 'После ответа о состоянии, один раз.' }, { phrase: 'Не хочу обязательных кредитов и скрытых доплат.', whenAppropriate: 'После обсуждения цены, один раз.' }],
        successCriteria: [{ expectedAnswer: 'Менеджер поясняет наличие и состояние, озвучивает итоговую цену и условия осмотра без обязательных доплат.' }] },
      importedItem: { id: car.id, title: car.title, description: 'Цена объявления 6 405 000 рублей. Пробег 18 000 километров. Комплектация и история обслуживания требуют уточнения.' },
      // Test manager ground truth, deliberately NOT part of the client legend,
      // imported advertisement or runtime car known by the tested AI.
      managerFixture: { available: true, price: 6405000, mileage: 18000, history: 'Один владелец, ДТП не было. Обслуживание по регламенту, заказ-наряды и отчёт по истории доступны.',
        inspection: 'Независимая диагностика разрешена; завтра в 18:00, Москва, Тестовая, 10.',
        terms: 'Без обязательного кредита, услуг и скрытых доплат. Итоговая цена 6 405 000 рублей.' },
      runtime: { car },
    };
    return { id: female ? 'trainer-builtin-female-v1' : kind === 'talkative' ? 'trainer-builtin-talkative-v1' : TRAINER_BUILTIN_SUITE_ID, name: `Встроенный набор · ${profileName}`, companyId: null, context, female };
  }
  return { source: source('skeptic'), femaleSource: source('female'), talkativeSource: source('talkative') };
}
