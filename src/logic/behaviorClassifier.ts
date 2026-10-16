/**
 * BehaviorClassifier — deterministic, rule-based behavior analysis for every manager message.
 * LLM is NOT used here; all detection is regex/token-list based for speed and consistency.
 */

export type BehaviorSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface BehaviorSignal {
  profanity: boolean;
  toxic: boolean;
  low_effort: boolean;
  disengaging: boolean;
  low_quality: boolean;
  evasion: boolean;
  prohibited_phrase_hits: string[];
  severity: BehaviorSeverity;
  rationale: string;
}

// ── Token lists ──

const PROFANITY_STEMS = [
  'хуй', 'хуе', 'хуя', 'хуи', 'хуё',
  'пизд', 'пизж',
  'бля', 'блят', 'блядь', 'блядс',
  'ебат', 'ебан', 'ебал', 'ебну', 'ёбан', 'ебу',
  'сука', 'суки', 'сучк',
  'нахуй', 'нахер', 'нахрен',
  'залуп', 'мудак', 'мудил',
  'пидор', 'пидар',
  'гандон', 'гондон',
  'дерьм',
  'жоп',
];

const HOSTILE_PATTERNS = [
  'отвали',
  'отстань',
  'пошёл на',
  'пошел на',
  'да пошёл ты',
  'да пошел ты',
  'иди на',
  'иди ты',
  'закрой рот',
  'заткнись',
  'задолбал',
  'задолбала',
  'достал',
  'достала',
  'чё ты хочешь',
  'че ты хочешь',
  'мне пофиг',
  'мне плевать',
  'да мне насрать',
];

const DISMISSIVE_PATTERNS = [
  'не моя проблема',
  'сами разбирайтесь',
  'звоните куда-нибудь',
  'гуглите',
  'в интернете посмотрите',
  'мне всё равно',
  'это не ко мне',
  'ничем не могу помочь',
  'не знаю и знать не хочу',
];

const PROHIBITED_PHRASES = [
  'позвоните позже',
  'перезвоните',
  'напишите на сайте',
  'оставьте заявку на сайте',
  'посмотрите на сайте',
  'всё написано в объявлении',
  'читайте объявление',
  'я не знаю',
  'без понятия',
  'не в курсе',
  'не могу сказать',
];

const NONSENSE_TOKENS = [
  'хз', 'незнаю', 'не знаю', 'норм', 'лол', 'ща',
  'тачка топ', 'кек', 'лмао', 'ахах',
];

const LOW_EFFORT_ONLY_TOKENS = [
  'ок', 'ладно', 'ясно', 'угу', 'ага', 'да', 'нет', 'ну',
];

const DISENGAGING_PATTERNS = [
  'не звоните',
  'больше не звоните',
  'не надо мне звонить',
  'не хочу разговаривать',
  'не хочу говорить',
  'не хочу общаться',
  'отстаньте',
  'закончим разговор',
  "don't call",
  'do not call',
  'stop calling',
  "i don't want to talk",
  'leave me alone',
];

// ── Helpers ──

function normalize(text: string): string {
  return text.toLowerCase().replace(/[ё]/g, 'е').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, patterns: string[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    if (text.includes(p)) hits.push(p);
  }
  return hits;
}

function containsProfanity(text: string): string[] {
  const tokens = text.split(/[^a-zа-я0-9ё]+/i).filter(Boolean);
  return PROFANITY_STEMS.filter((stem) => tokens.some((token) => token.startsWith(stem)));
}

function isLikelyDisengaging(text: string): boolean {
  const direct = containsAny(text, DISENGAGING_PATTERNS);
  if (direct.length > 0) return true;
  const stopAndTalkRegex =
    /(не\s*(хочу|буду).*(разговар|говор|общат))|((stop|dont|don't)\s+(call|talk|message))/i;
  return stopAndTalkRegex.test(text);
}

// ── Main classifier ──

export function classifyBehavior(
  managerMessage: string,
  context: {
    lastClientQuestion?: string;
    isClientWaitingAnswer: boolean;
  }
): BehaviorSignal {
  const norm = normalize(managerMessage);
  const words = norm.split(' ').filter(Boolean);
  const wordCount = words.length;
  const charCount = norm.length;

  const reasons: string[] = [];

  // ── Toxic detection ──
  // Match profanity stems only at the beginning of a token. A raw substring
  // search incorrectly classified normal words such as "рубля" as profanity.
  const profanityHits = containsProfanity(norm);
  const hostileHits = containsAny(norm, HOSTILE_PATTERNS);
  const dismissiveHits = containsAny(norm, DISMISSIVE_PATTERNS);
  const disengaging = isLikelyDisengaging(norm);

  const toxic = profanityHits.length > 0 || hostileHits.length > 0;
  if (profanityHits.length > 0) reasons.push('profanity detected');
  if (hostileHits.length > 0) reasons.push('hostile language');
  if (disengaging) reasons.push('conversation shutdown / refusal intent');

  // ── Prohibited phrase detection ──
  const prohibitedHits = [
    ...containsAny(norm, PROHIBITED_PHRASES),
    ...dismissiveHits,
  ];
  if (prohibitedHits.length > 0) reasons.push(`prohibited phrases: ${prohibitedHits.join(', ')}`);

  // ── Low effort detection ──
  const isVeryShort = charCount <= 15 || wordCount <= 2;
  const isNonsense = NONSENSE_TOKENS.some((t) => norm.includes(t));
  const isOnlyFiller = wordCount <= 3 && LOW_EFFORT_ONLY_TOKENS.some((t) => words.includes(t));
  const isLowEffort = isVeryShort || isNonsense || isOnlyFiller;
  if (isVeryShort) reasons.push(`very short (${charCount} chars, ${wordCount} words)`);
  if (isNonsense) reasons.push('nonsense/slang token');
  if (isOnlyFiller) reasons.push('only filler words');

  // ── Evasion detection ──
  let evasion = false;
  if (context.isClientWaitingAnswer) {
    const answersNothing =
      isLowEffort ||
      disengaging ||
      dismissiveHits.length > 0 ||
      containsAny(norm, ['не знаю', 'без понятия', 'не в курсе', 'не могу сказать']).length > 0;
    if (answersNothing) {
      evasion = true;
      reasons.push('evaded client question');
    }
  }

  const lowQuality = disengaging || dismissiveHits.length > 0 || (isLowEffort && evasion);
  if (lowQuality && !disengaging) reasons.push('low-quality / disengaged answer');

  // ── Severity ──
  let severity: BehaviorSeverity = 'LOW';
  if (toxic || disengaging) {
    severity = 'HIGH';
  } else if (dismissiveHits.length > 0 || (isLowEffort && evasion)) {
    severity = 'MEDIUM';
  } else if (isLowEffort || prohibitedHits.length > 0) {
    severity = 'LOW';
  }

  return {
    profanity: profanityHits.length > 0,
    toxic,
    low_effort: isLowEffort,
    disengaging,
    low_quality: lowQuality,
    evasion,
    prohibited_phrase_hits: prohibitedHits,
    severity,
    rationale: reasons.length > 0 ? reasons.join('; ') : 'no issues detected',
  };
}
