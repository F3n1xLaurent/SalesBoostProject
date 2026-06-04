import type { TranscriptTurn } from '../lib/demoMockEvaluation';
import transcriptsJson from '../../../data/demo-example-transcripts.json';
import type { ExampleTier } from './types';

export type { ExampleTier } from './types';

export type DemoExampleMeta = {
  id: ExampleTier;
  /** Подпись рядом с цветной точкой */
  managerLabel: string;
  dotClass: 'demo-example-card__dot--bad' | 'demo-example-card__dot--mid' | 'demo-example-card__dot--good';
  title: string;
  teaser: string;
  transcript: TranscriptTurn[];
};

const T = transcriptsJson as Record<ExampleTier, TranscriptTurn[]>;

export const DEMO_REPORT_EXAMPLES: DemoExampleMeta[] = [
  {
    id: 'weak',
    managerLabel: 'Слабый менеджер',
    dotClass: 'demo-example-card__dot--bad',
    title: '«Сколько стоит?» — и тишина',
    teaser: 'Клиент давит по цене и шагу, менеджер уходит в общие фразы.',
    transcript: T.weak,
  },
  {
    id: 'medium',
    managerLabel: 'Средний менеджер',
    dotClass: 'demo-example-card__dot--mid',
    title: 'Вежливо, но без крючка в календарь',
    teaser: 'Точка, имя и грубый ориентир по платежу есть, а презентация размытая и финал — «напишите сами», без даты показа.',
    transcript: T.medium,
  },
  {
    id: 'strong',
    managerLabel: 'Сильный менеджер',
    dotClass: 'demo-example-card__dot--good',
    title: '«От дорого» до записи',
    teaser: 'Точка, вилка по цене, трейд-ин, отработка цены двумя вариантами и жёсткая запись на тест-драйв.',
    transcript: T.strong,
  },
];
