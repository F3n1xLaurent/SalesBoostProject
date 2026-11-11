import type { TranscriptTurn } from './callHistory';

const TOPICS = [
  /тест[ -]?драйв/iu,
  /пробег|километр/iu,
  /кредит|рассроч/iu,
  /дтп|авари|не\s+бит|окрас/iu,
  /визит|прие[хз]|подъе[хз]|осмотр/iu,
];
const CLAIM = /(?:спросил|уточнил|задал\s+вопрос|назвал|сообщил|предложил|пригласил|ответил|подтвердил|рассказал)/giu;

/** Observable useful content; this is not verification of product facts. */
export function hasGroundedProductAnswer(index: number, transcript: readonly TranscriptTurn[]): boolean {
  const answer = transcript[index]?.text ?? '';
  const question = transcript.slice(0, index).filter(turn => turn.role === 'client').at(-1)?.text ?? '';
  const answers = (answer.match(/[^.!?;]+[.!?;]?/gu) ?? [])
    .filter(part => !part.trimEnd().endsWith('?'))
    .flatMap(part => part.split(/\s+(?:но|однако)\s+/iu));
  const topics = [
    [/коробк|трансмисси/iu, /автомат|механик|вариатор|робот|\d+\s*(?:AT|АТ|ступен)/iu],
    [/габарит|размер|ширин|длин|парков/iu, /среднеразмер|длин[^.!?]*\d|ширин[^.!?]*\d|автоматическ[^.!?]*парков/iu],
    [/опци|комфорт|мультимеди|климат|сидень/iu, /зарядк|подогрев|вентиляц|панорам|климат|экран|мультимеди/iu],
  ];
  return topics.some(([topic, response]) => topic.test(question) && answers.some(part =>
    response.test(part) && !/(?:не\s+(?:знаю|известн|расслыш|понял|могу\s+(?:сказать|ответить|уточнить))|нет\s+информации|нужно\s+проверить|без\s+понятия|возможно|наверное|может\s+быть)/iu.test(part)));
}

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
