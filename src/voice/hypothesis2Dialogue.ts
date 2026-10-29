/** Adapt transport instructions, not business questions, in the isolated bridge. */
export function adaptHypothesis2Prompt(prompt: string): string {
  return prompt
    .replace(/используй существующую процедуру Finish call/giu, 'подтверди договорённость, естественно попрощайся одной репликой и вызови end_call')
    .replace(/При voicemail используй отдельную процедуру\./giu, 'Если это автоответчик, не веди с ним диалог; вызови end_call.')
    .replace(/Не вызывай end_call напрямую и не создавай обычную финальную реплику перед процедурой\./giu, 'Не озвучивай названия процедур и инструментов.');
}

export function profileIdentity(prompt: string): { name: string | null; gender: string | null } {
  // Test persona is appended after the plan; its explicit identity wins.
  const names = [...prompt.matchAll(/(?:^|\s)[Тт]ы\s+([А-ЯЁ][а-яё-]+)\s*,\s*(?:женщина|мужчина)/gu)];
  const genders = [...prompt.matchAll(/(?:Голос клиента:\s*(Женский|Мужской)|ты\s+[А-ЯЁ][а-яё-]+\s*,\s*(женщина|мужчина))/giu)];
  const last = genders.at(-1);
  const raw = last?.[1] ?? last?.[2];
  return { name: names.at(-1)?.[1] ?? null, gender: raw ? (/^жен/iu.test(raw) ? 'женский' : 'мужской') : null };
}

/** Only replace a self-introduction; never rewrite the employee's name. */
export function pinSelfIntroduction(text: string, name: string | null): string {
  if (!name) return text;
  return text.replace(/((?:меня\s+зовут|моё\s+имя)\s+)не\s+[а-яё][а-яё-]{1,30}\s*,?\s*а\s+[а-яё][а-яё-]{1,30}/giu, `$1${name}`)
    .replace(/((?:меня\s+зовут|моё\s+имя)\s+)[а-яё][а-яё-]{1,30}/giu, `$1${name}`)
    .replace(/(^|[.!?]\s*)(Я\s+)[А-ЯЁ][а-яё-]+(?=[,.!?]|$)/gu, `$1$2${name}`);
}

/** Preserve only an explicit requested callback time, never invent one. */
export function callbackFarewell(text: string): string | null {
  if (/(?:не\s+перезванива|не\s+надо\s+перезванива)/iu.test(text)) return null;
  const request = text.match(/(?:перезвоните|перезвони|(?:можете|сможете)\s+перезвонить)(?=[\s,!?.—-]|$)\s*[,—-]?\s*([^.!?]*)/iu);
  if (!request) return null;
  // A callback plus an unrelated question must still be handled by the model.
  const other = text.slice(0, request.index).replace(/я\s+сейчас\s+занят[а]?/iu, '');
  const tail = text.slice((request.index ?? 0) + request[0].length).replace(/^[.!?]\s*/u, '');
  if (/[?]/u.test(other + tail) || /(?:^|\s)(?:какой|какая|сколько|почему)(?=\s|$)/iu.test(request[1])) return null;
  const time = request[1].replace(/пожалуйста/giu, '').replace(/^[\s,]+|[\s,]+$/gu, '').replace(/^(?:мне|нам)\s+/iu, '');
  return time ? `Хорошо, перезвоню ${time}. До свидания.` : 'Хорошо, перезвоню. До свидания.';
}
