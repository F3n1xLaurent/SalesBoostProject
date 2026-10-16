export type ConversationFactTurn = {
  role: string;
  content?: unknown;
  text?: unknown;
};

function textOf(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

/** A semantic fact: the manager explicitly asked how to address the client. */
export function isClientNameRequest(value: unknown): boolean {
  const text = textOf(value);
  return /(?:как\s+(?:я\s+)?могу\s+к\s+вам\s+обращаться|как\s+к\s+вам\s+обращаться|как\s+вас\s+зовут|назовите[^?.!]*(?:ваше\s+имя|свое\s+имя)|подскажите[^?.!]*(?:ваше\s+имя|как[^?.!]*обращаться))/u.test(text);
}

export function findManagerClientNameRequest(transcript: ConversationFactTurn[]): string | null {
  for (const turn of transcript) {
    if (turn.role !== 'manager' && turn.role !== 'assistant') continue;
    const original = String(turn.content ?? turn.text ?? '').trim();
    if (isClientNameRequest(original)) return original;
  }
  return null;
}

/**
 * Custom checklist IDs are user-defined, so detect this common intent from
 * the criterion wording rather than relying on a particular UUID/code.
 */
export function isClientNameCriterion(definition: {
  title?: unknown;
  instruction?: unknown;
  category?: unknown;
}): boolean {
  const text = textOf(`${definition.title ?? ''} ${definition.instruction ?? ''} ${definition.category ?? ''}`);
  return /(?:имя\s+(?:клиента|покупателя)|(?:уточнил|спросил|узнал)[^.!?]{0,40}имя|как[^.!?]{0,30}обращаться)/u.test(text)
    && !/(?:представился|имя\s+менеджера|свое\s+имя)/u.test(text);
}
