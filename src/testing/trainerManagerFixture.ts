import type { TrainerTestSource, TrainerTestTurn } from './trainerAutoTesting';

/** A manager knows more than the customer. No endlessly generated "уточню".
 * Facts live in a separate fixture, never in the tested customer's prompt.
 */
export function trainerManagerFixtureReply(source: TrainerTestSource, turns: readonly TrainerTestTurn[]): string | null {
  const facts = source.context.managerFixture as Record<string, unknown> | undefined;
  if (!facts) return null; // Legacy datasets retain the existing adaptive actor.
  const last = turns.filter((turn) => turn.role === 'client').at(-1)?.text ?? '';
  const focus = last.match(/[^.!?]*\?/gu)?.at(-1) ?? last;
  if (/(?:до свидания|всего доброго|до встречи)/iu.test(last)) return 'Спасибо за разговор, до свидания.';
  if (/(?:та же|друг(?:ая|ую)|верн[её]мся|именно.*модель)/iu.test(focus)) return 'Вы правы: говорим именно о Mercedes-Benz GLE 2023 года из объявления. Упоминание другого автомобиля, года или базовой комплектации было ошибкой. Подтверждённые сведения относятся к GLE.';
  if (/(?:диагност|осмотр|приех|подъех|независим|адрес|во сколько)/iu.test(focus)) return `Да, ${String(facts.inspection)} Могу отправить подтверждение и мой контакт на этот номер.`;
  if (/(?:цен|стоим|доплат|кредит|услуг|скрыт|комисси)/iu.test(focus)) return String(facts.terms);
  if (/(?:истори|состоян|дтп|обслуж|подтверд|документ|довер|сомнева)/iu.test(focus)) return `${String(facts.history)} Пробег ${String(facts.mileage)} километров подтверждён документами; могу прислать их и показать на осмотре.`;
  if (/(?:пробег|километр)/iu.test(focus)) return `Пробег ${String(facts.mileage)} километров, актуальный, подтверждён сервисной историей.`;
  if (/(?:налич|актуаль|жду|ожида|не уш[её]л)/iu.test(last)) return 'Mercedes-Benz GLE 2023 года в наличии, объявление актуально. Могу ответить на вопросы о состоянии и условиях покупки.';
  return `Автомобиль в наличии. ${String(facts.history)} ${String(facts.terms)} ${String(facts.inspection)}`;
}
