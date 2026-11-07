import type { TranscriptTurn } from './callHistory';

const TOPICS = [
  /тест[ -]?драйв/iu,
  /пробег|километр/iu,
  /кредит|рассроч/iu,
  /дтп|авари|не\s+бит|окрас/iu,
  /визит|прие[хз]|подъе[хз]|осмотр/iu,
];
const CLAIM = /(?:спросил|уточнил|задал\s+вопрос|назвал|сообщил|предложил|пригласил|ответил|подтвердил|рассказал)/giu;

/** Reject a narrow, observable attribution error: a comment claims the
 * employee discussed a topic which only appears in a later employee reply.
 * Absence-based criticism and interpretation of a short «да» stay intact. */
export function groundReportTurnComment(value: string, index: number, transcript: readonly TranscriptTurn[]): string {
  if (index < 0 || !value) return value;
  const own = transcript[index]?.text ?? '';
  const affirmative = /^(?:да|нет|конечно|верно|хорошо|договорились|жд[её]м)[,.!\s]*$/iu.test(own.trim());
  const known = affirmative ? transcript.slice(0, index + 1).map(turn => turn.text).join(' ') : own;
  const future = transcript.slice(index + 1).filter(turn => turn.role === 'manager').map(turn => turn.text).join(' ');
  return value.split(/(?<=[.!?])\s+/u).filter(sentence => {
    for (const claim of sentence.matchAll(CLAIM)) {
      if (/(?:^|\s)не\s*$/iu.test(sentence.slice(0, claim.index))) continue;
      const clause = sentence.slice(claim.index + claim[0].length).split(/[,;]|\sно\s|\sоднако\s/iu)[0];
      if (TOPICS.some(topic => topic.test(clause) && !topic.test(known) && topic.test(future))) return false;
    }
    return true;
  }).join(' ').trim();
}
