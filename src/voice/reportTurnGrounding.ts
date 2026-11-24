import type { TranscriptTurn } from './callHistory';

/** Streaming ASR may split one manager reply into several adjacent turns.
 * Include that entire reply, stopping before any later customer disclosure. */
export function managerReplyContext(transcript: readonly TranscriptTurn[], index: number): TranscriptTurn[] {
  if (transcript[index]?.role !== 'manager') return transcript.slice(0, index + 1);
  let first = index, last = index;
  while (first > 0 && transcript[first - 1].role === 'manager') first--;
  while (last + 1 < transcript.length && transcript[last + 1].role === 'manager') last++;
  return [...transcript.slice(0, first), { role: 'manager', text: transcript.slice(first, last + 1).map(turn => turn.text).join(' ') }];
}

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
  if (/(?:выяснил|установил|определил)\s+срок/iu.test(value)) {
    const reply = transcript.slice(index + 1).find(turn => turn.role === 'client')?.text ?? '';
    if (!/сегодня|завтра|послезавтра|недел|месяц|в\s+течени|через\s+\d|ближайш.{0,15}дн|пока\s+не\s+(?:решил|определил)/iu.test(reply)) {
      value = value.replace(/(?:выяснил|установил|определил)\s+срок(?:и)?(?:\s+покупки)?/giu, 'спросил о сроке покупки (ответ клиента о сроке не зафиксирован)');
    }
  }
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
