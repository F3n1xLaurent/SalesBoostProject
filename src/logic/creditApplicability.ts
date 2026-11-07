type CreditTurn = { role: string; content?: unknown; text?: unknown };
const CREDIT = /кредит|рассроч/iu;
const textOf = (turn: CreditTurn) => String(turn.content ?? turn.text ?? '').trim();

/** A payment-choice question is not a request for a credit consultation.
 * Only the client's question, explicit choice, or acceptance triggers it. */
export function creditConsultationRequested(turns: readonly CreditTurn[]): boolean {
  let previousManager = '';
  for (const turn of turns) {
    const text = textOf(turn);
    if (turn.role === 'manager' || turn.role === 'assistant') { previousManager = text; continue; }
    if (turn.role !== 'client' && turn.role !== 'user') continue;
    if (CREDIT.test(text)) {
      const declined = /(?:без\s+кредита|кредит[^.!?]{0,25}не\s+(?:нуж(?:ен|на|но)|интерес(?:ует|ен|на|но)|рассматрива|подходит)|не\s+(?:хочу|буду|рассматриваю)[^.!?]{0,25}кредит)/iu.test(text);
      const undecided = /пока\s+(?:выбираю|думаю|решаю)|не\s+(?:определил|решил)/iu.test(text);
      const asksTerms = /\?|подскажите|расскажите|объясните|интересу[ею]|хочу\s+(?:узнать|уточнить)/iu.test(text);
      if (asksTerms && (!declined || /какая\s+ставка|какой\s+(?:плат[её]ж|взнос)|какие\s+условия\s+кредит|цена\s+в\s+кредит/iu.test(text))) return true;
      if (!declined && !undecided && /(?:в\s+кредит|кредит(?:ом|у)?(?:[\s,.!]|$)|рассрочку)/iu.test(text)) return true;
    }
    // «Да» to a single credit offer is acceptance; «да» to an alternative
    // such as «наличные или кредит?» does not tell us which option was chosen.
    const answer = text.replace(/[,!.?]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (/^(?:да|да\s+да|да\s+конечно|интересует|давайте|хорошо)$/iu.test(answer)
      && CREDIT.test(previousManager) && /\?|предлага|рассмотр|интересует/iu.test(previousManager)
      && !/наличн|картой|сво[иы]\s+средств|или|либо/iu.test(previousManager)) return true;
  }
  return false;
}

export function isCreditExplanationCriterion(definition: { title?: unknown; instruction?: unknown }): boolean {
  const title = String(definition.title ?? '');
  return CREDIT.test(title) && /объясн|услови|консультац|рассказ|программ/iu.test(title);
}

export function conditionalCreditCriterion(definition: { title?: unknown; instruction?: unknown }): boolean {
  return isCreditExplanationCriterion(definition)
    && /(?:если|при\s+(?:наличии|запросе|интересе))[^.!?]{0,100}(?:кредит|рассроч|клиент[^.!?]{0,25}(?:запрос|интерес|спрос))/iu.test(String(definition.instruction ?? ''));
}
