/**
 * Mock data layer for the Super Admin / Holding dealership views.
 *
 * Toggle:  VITE_USE_MOCK_DATA=false  in .env to disable.
 * Defaults to ON — mock data is used as a fallback whenever real data is empty.
 * When real backend data is ready, set VITE_USE_MOCK_DATA=false to disable mocks.
 */

export const USE_MOCK =
  import.meta.env.VITE_USE_MOCK_DATA !== 'false';

/* ────────────────────────── Types ────────────────────────── */

export type DealershipStatus = 'norm' | 'risk' | 'critical' | 'no-data';

export interface DealershipRow {
  id: string;
  name: string;
  city: string;
  aiRating: number;
  answerRate: number | null;
  avgAnswerTimeSec: number | null;
  auditsCount: number;
  employeesCount: number;
  deltaRating: number | null;
  status: DealershipStatus;
}

export interface EmployeeRow {
  id: string;
  name: string;
  aiRating: number;
  auditsCount: number;
  typicalError: string;
  status: string;
}

export interface DealershipAudit {
  id: string;
  date: string;
  type: 'training' | 'call';
  employeeName: string;
  score: number;
}

export interface DealershipDetail extends DealershipRow {
  employees: EmployeeRow[];
  audits: DealershipAudit[];
  timeSeries: { date: string; avgScore: number; count: number }[];
  hourlyAnswerRate: number[];
  topIssues: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
}

/* ────────────────────── Status computation ────────────────────── */

export function computeStatus(
  aiRating: number,
  answerRate: number | null,
  deltaRating: number | null,
  auditsCount: number,
): DealershipStatus {
  if (auditsCount === 0) return 'no-data';
  if (aiRating < 50 || (answerRate !== null && answerRate < 60)) return 'critical';
  if (aiRating < 70 || (deltaRating !== null && deltaRating < -10)) return 'risk';
  return 'norm';
}

export const STATUS_LABELS: Record<DealershipStatus, string> = {
  norm: 'Норма',
  risk: 'Риск',
  critical: 'Критично',
  'no-data': 'Нет данных',
};

export const STATUS_ORDER: Record<DealershipStatus, number> = {
  critical: 0,
  risk: 1,
  norm: 2,
  'no-data': 3,
};

/* ────────────────────── Seed data pools ────────────────────── */

const EMPLOYEE_NAMES = [
  'Иванов Алексей', 'Петрова Мария', 'Сидоров Дмитрий', 'Козлова Анна',
  'Михайлов Сергей', 'Фёдорова Елена', 'Новиков Андрей', 'Морозова Ольга',
  'Волков Николай', 'Лебедева Татьяна', 'Кузнецов Павел', 'Соколова Ирина',
  'Попов Артём', 'Васильева Юлия', 'Смирнов Максим', 'Николаева Дарья',
  'Орлов Роман', 'Макарова Светлана', 'Зайцев Илья', 'Егорова Виктория',
  'Белов Денис', 'Тихонова Наталья', 'Громов Кирилл', 'Ковалёва Алина',
  'Крылов Евгений', 'Степанова Екатерина', 'Богданов Антон', 'Жукова Полина',
  'Филиппов Олег', 'Борисова Ксения', 'Комаров Вадим', 'Гусева Марина',
  'Захаров Георгий', 'Данилова Валерия', 'Тарасов Владислав', 'Кудрявцева Софья',
  'Савельев Тимур', 'Калинина Анастасия', 'Медведев Глеб', 'Панова Диана',
];

const TYPICAL_ERRORS = [
  'Не выявляет потребности',
  'Пропускает презентацию',
  'Не работает с возражениями',
  'Нет следующего шага',
  'Не закрывает сделку',
  'Слабое приветствие',
  'Нет кросс-продаж',
  'Монолог вместо диалога',
  'Не использует скрипт',
  'Не фиксирует договорённости',
];

const EMPLOYEE_STATUSES = ['Активен', 'Нуждается в обучении', 'Стажёр'];

const TOP_QUESTIONS = [
  'Какие комплектации доступны?',
  'Есть ли trade-in?',
  'Условия кредитования?',
  'Сроки поставки?',
  'Гарантийные условия?',
  'Доступна ли тест-драйв?',
  'Какие акции сейчас?',
  'Есть ли рассрочка без переплат?',
  'Можно ли заказать цвет?',
  'Какие допы входят в цену?',
];

const TRAININGS = [
  { title: 'Работа с возражениями', description: 'Техники преодоления типовых возражений клиентов' },
  { title: 'Выявление потребностей', description: 'SPIN-продажи и открытые вопросы' },
  { title: 'Техника закрытия сделки', description: 'Финальный этап переговоров и фиксация результата' },
  { title: 'Кросс-продажи', description: 'Предложение дополнительных услуг и аксессуаров' },
  { title: 'Телефонный этикет', description: 'Правила первого контакта по телефону' },
];

/* ────────────────── Deterministic pseudo-random ────────────────── */

function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/* ────────────────── Raw dealership seed data ────────────────── */

interface DealershipSeed {
  id: string;
  name: string;
  city: string;
  aiRating: number;
  answerRate: number | null;
  avgAnswerTimeSec: number | null;
  auditsCount: number;
  employeesCount: number;
  deltaRating: number | null;
}

const DEALERSHIP_SEEDS: DealershipSeed[] = [
  { id: 'd01', name: 'Центральный',   city: 'Москва',         aiRating: 91, answerRate: 88, avgAnswerTimeSec: 11, auditsCount: 28, employeesCount: 14, deltaRating: 5 },
  { id: 'd02', name: 'Север',         city: 'Москва',         aiRating: 74, answerRate: 78, avgAnswerTimeSec: 19, auditsCount: 16, employeesCount: 8,  deltaRating: -3 },
  { id: 'd03', name: 'Юг',            city: 'Москва',         aiRating: 63, answerRate: 72, avgAnswerTimeSec: 22, auditsCount: 12, employeesCount: 7,  deltaRating: -12 },
  { id: 'd04', name: 'Запад',         city: 'Москва',         aiRating: 45, answerRate: 55, avgAnswerTimeSec: 35, auditsCount: 8,  employeesCount: 6,  deltaRating: -8 },
  { id: 'd05', name: 'Восток',        city: 'Москва',         aiRating: 82, answerRate: null, avgAnswerTimeSec: null, auditsCount: 20, employeesCount: 11, deltaRating: 2 },
  { id: 'd06', name: 'Премиум',       city: 'Санкт-Петербург', aiRating: 88, answerRate: 91, avgAnswerTimeSec: 9,  auditsCount: 25, employeesCount: 15, deltaRating: 7 },
  { id: 'd07', name: 'Невский',       city: 'Санкт-Петербург', aiRating: 56, answerRate: 65, avgAnswerTimeSec: 28, auditsCount: 10, employeesCount: 8,  deltaRating: -5 },
  { id: 'd08', name: 'Балтика',       city: 'Санкт-Петербург', aiRating: 71, answerRate: 82, avgAnswerTimeSec: 16, auditsCount: 14, employeesCount: 10, deltaRating: 1 },
  { id: 'd09', name: 'Нева',          city: 'Санкт-Петербург', aiRating: 38, answerRate: 48, avgAnswerTimeSec: 42, auditsCount: 5,  employeesCount: 5,  deltaRating: -15 },
  { id: 'd10', name: 'Казань Авто',   city: 'Казань',         aiRating: 79, answerRate: 85, avgAnswerTimeSec: 14, auditsCount: 18, employeesCount: 12, deltaRating: 3 },
  { id: 'd11', name: 'Волга',         city: 'Казань',         aiRating: 67, answerRate: 74, avgAnswerTimeSec: 20, auditsCount: 11, employeesCount: 7,  deltaRating: -2 },
  { id: 'd12', name: 'Татарстан',     city: 'Казань',         aiRating: 52, answerRate: null, avgAnswerTimeSec: null, auditsCount: 7, employeesCount: 6, deltaRating: -11 },
  { id: 'd13', name: 'Урал',          city: 'Екатеринбург',   aiRating: 85, answerRate: 87, avgAnswerTimeSec: 10, auditsCount: 22, employeesCount: 13, deltaRating: 4 },
  { id: 'd14', name: 'Горный',        city: 'Екатеринбург',   aiRating: 43, answerRate: 58, avgAnswerTimeSec: 33, auditsCount: 4,  employeesCount: 5,  deltaRating: -9 },
  { id: 'd15', name: 'Звезда',        city: 'Екатеринбург',   aiRating: 76, answerRate: 80, avgAnswerTimeSec: 15, auditsCount: 0,  employeesCount: 8,  deltaRating: null },
];

/* ────────────────── Generator helpers ────────────────── */

function generateEmployees(seed: DealershipSeed): EmployeeRow[] {
  const rng = seededRng(parseInt(seed.id.replace('d', ''), 10) * 1000);
  const count = seed.employeesCount;
  const pool = [...EMPLOYEE_NAMES];
  const employees: EmployeeRow[] = [];

  for (let i = 0; i < count; i++) {
    const nameIdx = Math.floor(rng() * pool.length);
    const name = pool.splice(nameIdx, 1)[0] ?? EMPLOYEE_NAMES[i % EMPLOYEE_NAMES.length];
    const deviation = (rng() - 0.5) * 30;
    const rating = Math.max(15, Math.min(100, Math.round(seed.aiRating + deviation)));
    const audits = Math.max(0, Math.round(seed.auditsCount / count * (0.5 + rng())));
    const errorIdx = Math.floor(rng() * TYPICAL_ERRORS.length);
    const statusIdx = rating < 50 ? 1 : rating < 65 ? (rng() > 0.5 ? 1 : 2) : 0;

    employees.push({
      id: `${seed.id}-e${i}`,
      name,
      aiRating: rating,
      auditsCount: audits,
      typicalError: TYPICAL_ERRORS[errorIdx],
      status: EMPLOYEE_STATUSES[statusIdx],
    });
  }
  return employees;
}

function generateAudits(seed: DealershipSeed, employeeNames: string[]): DealershipAudit[] {
  const rng = seededRng(parseInt(seed.id.replace('d', ''), 10) * 2000);
  const count = seed.auditsCount;
  const audits: DealershipAudit[] = [];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(rng() * 30);
    const date = new Date(now - daysAgo * 86_400_000);
    const empIdx = Math.floor(rng() * employeeNames.length);
    const deviation = (rng() - 0.5) * 40;
    const score = Math.max(10, Math.min(100, Math.round(seed.aiRating + deviation)));

    audits.push({
      id: `${seed.id}-a${i}`,
      date: date.toISOString().slice(0, 10),
      type: rng() > 0.3 ? 'training' : 'call',
      employeeName: employeeNames[empIdx] ?? 'Неизвестный',
      score,
    });
  }
  return audits.sort((a, b) => b.date.localeCompare(a.date));
}

function generateTimeSeries(baseScore: number, days: number, seedNum: number): { date: string; avgScore: number; count: number }[] {
  const rng = seededRng(seedNum * 3000);
  const now = new Date();
  const series: { date: string; avgScore: number; count: number }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const deviation = (rng() - 0.5) * 20;
    const score = Math.max(10, Math.min(100, Math.round(baseScore + deviation)));
    const count = Math.max(1, Math.round(3 + rng() * 5));
    series.push({ date: d.toISOString().slice(0, 10), avgScore: score, count });
  }
  return series;
}

function generateHourly(answerRate: number | null, seedNum: number): number[] {
  if (answerRate === null) return new Array(24).fill(0);
  const rng = seededRng(seedNum * 4000);
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (h < 8 || h >= 21) {
      hours.push(0);
    } else {
      const base = answerRate * (0.7 + rng() * 0.6);
      hours.push(Math.max(0, Math.min(100, Math.round(base))));
    }
  }
  return hours;
}

function generateTopIssues(seedNum: number): { issue: string; percent: number }[] {
  const rng = seededRng(seedNum * 5000);
  const shuffled = [...TYPICAL_ERRORS].sort(() => rng() - 0.5);
  return shuffled.slice(0, 5).map((issue, i) => ({
    issue,
    percent: Math.round(45 - i * 7 + (rng() - 0.5) * 6),
  }));
}

/* ────────────────── Build dealership rows ────────────────── */

function buildRow(seed: DealershipSeed): DealershipRow {
  return {
    ...seed,
    status: computeStatus(seed.aiRating, seed.answerRate, seed.deltaRating, seed.auditsCount),
  };
}

function buildDetail(seed: DealershipSeed): DealershipDetail {
  const seedNum = parseInt(seed.id.replace('d', ''), 10);
  const employeesFull = MOCK_EMPLOYEES.filter((e) => e.dealershipId === seed.id);
  const employees: EmployeeRow[] = employeesFull.map((e) => ({
    id: e.id,
    name: e.fullName,
    aiRating: e.aiRating,
    auditsCount: e.auditsCount,
    typicalError: e.topMistakeLabel,
    status:
      e.status === 'critical'
        ? 'Нуждается в обучении'
        : e.status === 'risk'
        ? 'Стажёр'
        : 'Стабильно',
  }));
  const empNames = employees.map((e) => e.name);
  const audits = generateAudits(seed, empNames);
  const timeSeries = generateTimeSeries(seed.aiRating, 14, seedNum);
  const hourly = generateHourly(seed.answerRate, seedNum);
  const topIssues = generateTopIssues(seedNum);
  const rng = seededRng(seedNum * 6000);
  const shuffledQ = [...TOP_QUESTIONS].sort(() => rng() - 0.5);
  const shuffledT = [...TRAININGS].sort(() => rng() - 0.5);

  return {
    ...buildRow(seed),
    employees,
    audits,
    timeSeries,
    hourlyAnswerRate: hourly,
    topIssues,
    topQuestions: shuffledQ.slice(0, 5),
    recommendedTrainings: shuffledT.slice(0, 3),
  };
}

/* ────────────────── Public API ────────────────── */

export const MOCK_DEALERSHIPS: DealershipRow[] = DEALERSHIP_SEEDS.map(buildRow);

export function getMockDealershipDetail(id: string): DealershipDetail | null {
  const seed = DEALERSHIP_SEEDS.find((s) => s.id === id);
  if (!seed) return null;
  return buildDetail(seed);
}

export function getMockDealershipDetailByName(name: string): DealershipDetail | null {
  const seed = DEALERSHIP_SEEDS.find((s) => s.name === name);
  if (!seed) return null;
  return buildDetail(seed);
}

export function getAllCities(): string[] {
  return [...new Set(DEALERSHIP_SEEDS.map((s) => s.city))];
}

/**
 * Adapter: convert existing MockCompany[] (from API) to DealershipRow[].
 * Falls back to MOCK_DEALERSHIPS when USE_MOCK is true or data is empty.
 */
export function adaptCompaniesToRows(
  companies: { id: string; name: string; autodealers: number; avgAiScore: number; answerRate: number; lastAudit: string; trend: number }[],
): DealershipRow[] {
  if (USE_MOCK || companies.length === 0) return MOCK_DEALERSHIPS;

  return companies.map((c) => {
    const aiRating = Math.round(c.avgAiScore);
    const delta = c.trend === 1 ? 5 : c.trend === -1 ? -5 : 0;
    return {
      id: c.id,
      name: c.name,
      city: '—',
      aiRating,
      answerRate: c.answerRate,
      avgAnswerTimeSec: null,
      auditsCount: 0,
      employeesCount: c.autodealers,
      deltaRating: delta,
      status: computeStatus(aiRating, c.answerRate, delta, 1),
    };
  });
}

/* ═══════════════════════════════════════════════════════════
   EMPLOYEES — global list across all dealerships
   ═══════════════════════════════════════════════════════════ */

export type CommunicationFlag = 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';

export const COMM_LABELS: Record<CommunicationFlag, string> = {
  ok: 'Ок',
  fillers: 'Паразиты',
  aggression: 'Агрессия',
  profanity: 'Ненормативная',
  'low-engagement': 'Слабая вовлечённость',
};

export const COMM_BADGE_CLASS: Record<CommunicationFlag, string> = {
  ok: 'sa-comm-ok',
  fillers: 'sa-comm-fillers',
  aggression: 'sa-comm-aggression',
  profanity: 'sa-comm-profanity',
  'low-engagement': 'sa-comm-low',
};

export interface EmployeeFullRow {
  id: string;
  fullName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  aiRating: number;
  deltaRating: number | null;
  auditsCount: number;
  failsCount: number;
  communicationFlag: CommunicationFlag;
  topMistakeLabel: string;
  status: DealershipStatus;
}

export interface EmployeeAuditRecord {
  id: string;
  date: string;
  type: 'training' | 'call';
  score: number;
  verdict: string;
}

export interface EmployeeDetailData extends EmployeeFullRow {
  strengths: string[];
  growthAreas: string[];
  trainingFocus: string;
  timeSeries: { date: string; avgScore: number; count: number }[];
  blockBreakdown: { block: string; score: number; hint: string }[];
  topIssues: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
  audits: EmployeeAuditRecord[];
}

/* ────────── Employee status (different rules from dealership) ────────── */

export function computeEmployeeStatus(
  aiRating: number,
  failsCount: number,
  commFlag: CommunicationFlag,
  deltaRating: number | null,
  auditsCount: number,
): DealershipStatus {
  if (auditsCount === 0) return 'no-data';
  if (aiRating < 50 || failsCount >= 2 || commFlag === 'profanity' || commFlag === 'aggression') return 'critical';
  if (aiRating < 70 || (deltaRating !== null && deltaRating < -10) || commFlag === 'fillers' || commFlag === 'low-engagement') return 'risk';
  return 'norm';
}

/* ────────── Pools for employee detail ────────── */

const VERDICTS = [
  'Хороший результат', 'Средний уровень', 'Нуждается в доработке',
  'Провал — досрочное завершение', 'Отличное выявление потребностей',
  'Слабая работа с возражениями', 'Хорошая коммуникация', 'Не следовал скрипту',
  'Уверенная презентация', 'Не предложил следующий шаг',
];

const STRENGTHS_POOL = [
  'Выявление потребностей', 'Работа с возражениями', 'Коммуникабельность',
  'Знание продукта', 'Кросс-продажи', 'Уверенная презентация',
  'Позитивный настрой', 'Внимание к деталям',
];

const GROWTH_POOL = [
  'Закрытие сделки', 'Работа с кредитом', 'Следующий шаг',
  'Скрипт приветствия', 'Контроль эмоций', 'Кросс-продажи',
  'Работа с возражениями', 'Активное слушание',
];

const TRAINING_FOCUS_POOL = [
  'Работа с возражениями клиента',
  'Техника выявления потребностей',
  'Эффективное закрытие сделки',
  'Телефонный этикет и первый контакт',
  'Кросс-продажи и допродажи',
];

const EVAL_BLOCKS = [
  { block: 'Первый контакт', hint: 'Приветствие, установление контакта' },
  { block: 'Продажа/продукт', hint: 'Презентация автомобиля и комплектаций' },
  { block: 'Кредит/трейд-ин', hint: 'Предложение финансовых услуг' },
  { block: 'Работа с возражениями', hint: 'Преодоление сомнений клиента' },
  { block: 'Коммуникация', hint: 'Тон, скорость, вовлечённость' },
];

/* ────────── Communication flag assignment ────────── */

function assignCommFlag(aiRating: number, rng: () => number): CommunicationFlag {
  const r = rng();
  if (aiRating < 40) {
    if (r < 0.15) return 'profanity';
    if (r < 0.35) return 'aggression';
    if (r < 0.6) return 'fillers';
    return 'low-engagement';
  }
  if (aiRating < 60) {
    if (r < 0.03) return 'profanity';
    if (r < 0.08) return 'aggression';
    if (r < 0.25) return 'fillers';
    if (r < 0.45) return 'low-engagement';
    return 'ok';
  }
  if (aiRating < 75) {
    if (r < 0.10) return 'fillers';
    if (r < 0.20) return 'low-engagement';
    return 'ok';
  }
  return 'ok';
}

/* ────────── Global employee list generation ────────── */

function generateAllMockEmployees(): EmployeeFullRow[] {
  const result: EmployeeFullRow[] = [];
  let nameIdx = 0;

  for (const seed of DEALERSHIP_SEEDS) {
    const rng = seededRng(parseInt(seed.id.replace('d', ''), 10) * 7000);
    const count = seed.employeesCount;

    for (let i = 0; i < count; i++) {
      const fullName = EMPLOYEE_NAMES[nameIdx % EMPLOYEE_NAMES.length];
      nameIdx++;

      const deviation = (rng() - 0.5) * 30;
      const aiRating = Math.max(15, Math.min(100, Math.round(seed.aiRating + deviation)));
      const auditsCount = seed.auditsCount === 0 ? 0 : Math.max(0, Math.round((seed.auditsCount / count) * (0.5 + rng())));
      const commFlag: CommunicationFlag = auditsCount === 0 ? 'ok' : assignCommFlag(aiRating, rng);
      const failsCount = auditsCount === 0 ? 0 : aiRating < 50 ? Math.floor(rng() * 4) + 1 : aiRating < 65 ? Math.floor(rng() * 3) : Math.floor(rng() * 1.5);
      const deltaRating = auditsCount === 0 ? null : Math.round((rng() - 0.5) * 24);
      const errorIdx = Math.floor(rng() * TYPICAL_ERRORS.length);

      result.push({
        id: `${seed.id}-e${i}`,
        fullName,
        dealershipId: seed.id,
        dealershipName: seed.name,
        city: seed.city,
        aiRating,
        deltaRating,
        auditsCount,
        failsCount,
        communicationFlag: commFlag,
        topMistakeLabel: TYPICAL_ERRORS[errorIdx],
        status: computeEmployeeStatus(aiRating, failsCount, commFlag, deltaRating, auditsCount),
      });
    }
  }
  return result;
}

export const MOCK_EMPLOYEES: EmployeeFullRow[] = generateAllMockEmployees();

/* ────────── Employee detail ────────── */

export function getMockEmployeeDetail(id: string): EmployeeDetailData | null {
  const emp = MOCK_EMPLOYEES.find((e) => e.id === id);
  if (!emp) return null;

  const seedNum = parseInt(id.replace(/\D/g, ''), 10);
  const rng = seededRng(seedNum * 8000);

  const now = new Date();
  const timeSeries: EmployeeDetailData['timeSeries'] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dev = (rng() - 0.5) * 20;
    timeSeries.push({
      date: d.toISOString().slice(0, 10),
      avgScore: Math.max(10, Math.min(100, Math.round(emp.aiRating + dev))),
      count: Math.max(0, Math.round(rng() * 3)),
    });
  }

  const blockBreakdown = EVAL_BLOCKS.map((b) => ({
    ...b,
    score: Math.max(10, Math.min(100, Math.round(emp.aiRating + (rng() - 0.5) * 30))),
  }));

  const shuffledErrors = [...TYPICAL_ERRORS].sort(() => rng() - 0.5);
  const topIssues = shuffledErrors.slice(0, 5).map((issue, i) => ({
    issue,
    percent: Math.round(42 - i * 6 + (rng() - 0.5) * 8),
  }));

  const shuffledQ = [...TOP_QUESTIONS].sort(() => rng() - 0.5);
  const shuffledT = [...TRAININGS].sort(() => rng() - 0.5);
  const shuffledS = [...STRENGTHS_POOL].sort(() => rng() - 0.5);
  const shuffledG = [...GROWTH_POOL].sort(() => rng() - 0.5);
  const focusIdx = Math.floor(rng() * TRAINING_FOCUS_POOL.length);

  const audits: EmployeeAuditRecord[] = [];
  for (let i = 0; i < emp.auditsCount; i++) {
    const daysAgo = Math.floor(rng() * 30);
    const date = new Date(now.getTime() - daysAgo * 86_400_000);
    const dev = (rng() - 0.5) * 40;
    const score = Math.max(10, Math.min(100, Math.round(emp.aiRating + dev)));
    const verdictIdx = Math.floor(rng() * VERDICTS.length);
    audits.push({
      id: `${id}-a${i}`,
      date: date.toISOString().slice(0, 10),
      type: rng() > 0.3 ? 'training' : 'call',
      score,
      verdict: VERDICTS[verdictIdx],
    });
  }
  audits.sort((a, b) => b.date.localeCompare(a.date));

  return {
    ...emp,
    strengths: shuffledS.slice(0, 2),
    growthAreas: shuffledG.slice(0, 2),
    trainingFocus: TRAINING_FOCUS_POOL[focusIdx],
    timeSeries,
    blockBreakdown,
    topIssues,
    topQuestions: shuffledQ.slice(0, 5),
    recommendedTrainings: shuffledT.slice(0, 3),
    audits,
  };
}

export function getAllDealershipNamesForEmployees(): string[] {
  return [...new Set(MOCK_EMPLOYEES.map((e) => e.dealershipName))];
}

/* ═══════════════════════════════════════════════════════════
   AUDITS — universal audit center (trainer + call)
   ═══════════════════════════════════════════════════════════ */

export type AuditType = 'trainer' | 'call';
export type AuditStatus = 'completed' | 'failed' | 'interrupted';

export const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  trainer: 'Тренажёр',
  call: 'Звонок',
};

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  completed: 'Завершено',
  failed: 'Провал',
  interrupted: 'Прервано',
};

export const AUDIT_STATUS_CLASS: Record<AuditStatus, string> = {
  completed: 'sa-audit-status-completed',
  failed: 'sa-audit-status-failed',
  interrupted: 'sa-audit-status-interrupted',
};

/* ────────── Row for list page ────────── */

export interface AuditListRow {
  id: string;
  type: AuditType;
  dateTime: string;
  employeeId: string;
  employeeName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  totalScore: number;
  verdict: string;
  status: AuditStatus;
  duration: number;
  communicationFlag: CommunicationFlag;
}

/* ────────── Detail page types ────────── */

export interface ChecklistItem {
  label: string;
  result: 'pass' | 'warn' | 'fail';
  quote: string;
}

export interface TranscriptLine {
  speaker: 'client' | 'manager';
  time: string;
  text: string;
  critical?: boolean;
}

export interface AuditEvent {
  time: string;
  label: string;
  type: 'info' | 'warning' | 'error';
}

export interface AuditDetailData extends AuditListRow {
  blocksBreakdown: { block: string; score: number; hint: string }[];
  checklist: ChecklistItem[];
  transcript: TranscriptLine[];
  events: AuditEvent[];
  errors: { issue: string; percent: number }[];
  topQuestions: string[];
  recommendedTrainings: { title: string; description: string }[];
  answerTimeSec: number | null;
  attempts: number | null;
  callback: boolean | null;
  scenarioName: string | null;
  assignedBy: string | null;
  failReason: string | null;
}

/* ────────── Seed data for transcripts ────────── */

const CLIENT_LINES = [
  'Здравствуйте, я хотел бы узнать про новый кроссовер.',
  'Какие комплектации доступны?',
  'А есть trade-in?',
  'Это слишком дорого, есть что-то подешевле?',
  'Какие условия по кредиту?',
  'Мне нужно подумать.',
  'А можно тест-драйв?',
  'Какая гарантия?',
  'У конкурентов дешевле.',
  'Мне предложили скидку в другом салоне.',
  'А доп. оборудование входит в цену?',
  'Когда будет поставка?',
  'Можно забронировать?',
  'Хорошо, давайте оформлять.',
  'Нет, я ещё подумаю, перезвоню позже.',
];

const MANAGER_LINES = [
  'Добрый день! Рад вас приветствовать. Меня зовут {name}, чем могу помочь?',
  'Отличный выбор! Давайте расскажу подробнее.',
  'У нас есть несколько комплектаций, базовая от 2.5 млн.',
  'Да, мы принимаем trade-in. Давайте оценим ваш автомобиль.',
  'Кредит от 4.9%, одобрение за 30 минут.',
  'Понимаю. Давайте я подберу вариант под ваш бюджет.',
  'Конечно, тест-драйв можно записать прямо сейчас.',
  'Гарантия 5 лет или 150 000 км.',
  'Давайте сравним: у нас в цену уже включено...',
  'Могу предложить специальные условия, если оформим сегодня.',
  'Весь допкомплект уже в цене комплектации.',
  'Поставка 2–3 недели. Могу забронировать.',
  'Отлично, давайте перейдём к оформлению.',
  'Хорошо, я отправлю вам расчёт на почту.',
  'Буду рад помочь! Звоните в любое время.',
];

const CHECKLIST_ITEMS = [
  'Приветствие по стандарту',
  'Представление себя и компании',
  'Выявление потребностей (открытые вопросы)',
  'Презентация подходящих моделей',
  'Работа с бюджетом клиента',
  'Предложение кредита / рассрочки',
  'Предложение trade-in',
  'Работа с возражениями',
  'Кросс-продажи (допы, страховка)',
  'Фиксация договорённостей',
  'Назначение следующего шага',
  'Корректное завершение',
];

const EVENT_LABELS = [
  { label: 'Приветствие', type: 'info' as const },
  { label: 'Начало выявления потребностей', type: 'info' as const },
  { label: 'Пропущена презентация', type: 'warning' as const },
  { label: 'Возражение клиента', type: 'warning' as const },
  { label: 'Не предложен кредит', type: 'error' as const },
  { label: 'Успешная работа с возражением', type: 'info' as const },
  { label: 'Не предложен следующий шаг', type: 'error' as const },
  { label: 'Кросс-продажа предложена', type: 'info' as const },
  { label: 'Агрессивный тон менеджера', type: 'error' as const },
  { label: 'Клиент потерял интерес', type: 'warning' as const },
  { label: 'Корректное закрытие', type: 'info' as const },
  { label: 'Договорённости зафиксированы', type: 'info' as const },
];

const SCENARIO_NAMES = [
  'Первое обращение — кроссовер',
  'Повторный визит — кредит',
  'Работа с возражением — цена',
  'Trade-in запрос',
  'Тест-драйв — седан',
  'Допродажи — страховка',
];

const FAIL_REASONS = [
  'Менеджер прервал диалог',
  'Критическое нарушение скрипта',
  'Агрессия в адрес клиента',
  'Техническая ошибка',
  'Досрочное завершение сценария',
];

/* ────────── Generate audits ────────── */

function generateMockAudits(): AuditListRow[] {
  const rng = seededRng(42000);
  const result: AuditListRow[] = [];
  const now = Date.now();

  for (let i = 0; i < 35; i++) {
    const empIdx = Math.floor(rng() * MOCK_EMPLOYEES.length);
    const emp = MOCK_EMPLOYEES[empIdx];
    const isCall = rng() < 0.4;
    const type: AuditType = isCall ? 'call' : 'trainer';
    const daysAgo = Math.floor(rng() * 30);
    const hoursOff = Math.floor(rng() * 12) + 8;
    const dt = new Date(now - daysAgo * 86_400_000 + hoursOff * 3_600_000);

    const baseScore = emp.aiRating + (rng() - 0.5) * 40;
    const totalScore = Math.max(10, Math.min(100, Math.round(baseScore)));

    let status: AuditStatus = 'completed';
    if (i < 3) status = 'failed';
    else if (i < 5) status = 'interrupted';
    else if (totalScore < 30 && rng() < 0.5) status = 'failed';

    const verdictIdx = Math.floor(rng() * VERDICTS.length);
    const duration = Math.round(120 + rng() * 600);

    result.push({
      id: `audit-${String(i).padStart(3, '0')}`,
      type,
      dateTime: dt.toISOString(),
      employeeId: emp.id,
      employeeName: emp.fullName,
      dealershipId: emp.dealershipId,
      dealershipName: emp.dealershipName,
      city: emp.city,
      totalScore,
      verdict: status === 'failed' ? 'Провал — досрочное завершение' : VERDICTS[verdictIdx],
      status,
      duration,
      communicationFlag: emp.communicationFlag,
    });
  }

  return result.sort((a, b) => b.dateTime.localeCompare(a.dateTime));
}

export const MOCK_AUDITS: AuditListRow[] = generateMockAudits();

/* ────────── Audit detail ────────── */

export function getMockAuditDetail(id: string): AuditDetailData | null {
  const row = MOCK_AUDITS.find((a) => a.id === id);
  if (!row) return null;

  const seedNum = parseInt(id.replace(/\D/g, ''), 10);
  const rng = seededRng(seedNum * 9000);

  const blocksBreakdown = EVAL_BLOCKS.map((b) => ({
    ...b,
    score: Math.max(10, Math.min(100, Math.round(row.totalScore + (rng() - 0.5) * 30))),
  })).sort((a, b) => a.score - b.score);

  const checklist: ChecklistItem[] = CHECKLIST_ITEMS.map((label) => {
    const r = rng();
    const result: ChecklistItem['result'] = r < 0.6 ? 'pass' : r < 0.85 ? 'warn' : 'fail';
    const quotePool = result === 'pass' ? MANAGER_LINES : CLIENT_LINES;
    const quote = quotePool[Math.floor(rng() * quotePool.length)].replace('{name}', row.employeeName.split(' ')[1] || 'Менеджер');
    return { label, result, quote };
  });

  const lineCount = 12 + Math.floor(rng() * 8);
  const transcript: TranscriptLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    const isClient = i % 2 === 0;
    const pool = isClient ? CLIENT_LINES : MANAGER_LINES;
    const text = pool[Math.floor(rng() * pool.length)].replace('{name}', row.employeeName.split(' ')[1] || 'Менеджер');
    const mins = Math.floor(i * (row.duration / lineCount) / 60);
    const secs = Math.floor((i * (row.duration / lineCount)) % 60);
    transcript.push({
      speaker: isClient ? 'client' : 'manager',
      time: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
      text,
      critical: !isClient && rng() < 0.12,
    });
  }

  const eventCount = 5 + Math.floor(rng() * 5);
  const shuffledEvents = [...EVENT_LABELS].sort(() => rng() - 0.5);
  const events: AuditEvent[] = shuffledEvents.slice(0, eventCount).map((e, i) => ({
    ...e,
    time: `${String(Math.floor(i * 1.5)).padStart(2, '0')}:${String(Math.floor(rng() * 59)).padStart(2, '0')}`,
  }));

  const shuffledErrors = [...TYPICAL_ERRORS].sort(() => rng() - 0.5);
  const errors = shuffledErrors.slice(0, 5).map((issue, i) => ({
    issue,
    percent: Math.round(45 - i * 7 + (rng() - 0.5) * 6),
  }));

  const shuffledQ = [...TOP_QUESTIONS].sort(() => rng() - 0.5);
  const shuffledT = [...TRAININGS].sort(() => rng() - 0.5);

  return {
    ...row,
    blocksBreakdown,
    checklist,
    transcript,
    events,
    errors,
    topQuestions: shuffledQ.slice(0, 5),
    recommendedTrainings: shuffledT.slice(0, 3),
    answerTimeSec: row.type === 'call' ? Math.round(5 + rng() * 35) : null,
    attempts: row.type === 'call' ? Math.floor(1 + rng() * 4) : null,
    callback: row.type === 'call' ? rng() > 0.5 : null,
    scenarioName: row.type === 'trainer' ? SCENARIO_NAMES[Math.floor(rng() * SCENARIO_NAMES.length)] : null,
    assignedBy: row.type === 'trainer' ? 'Администратор' : null,
    failReason: row.status === 'failed' ? FAIL_REASONS[Math.floor(rng() * FAIL_REASONS.length)] : null,
  };
}

export function getAuditNavigationIds(currentId: string): { prevId: string | null; nextId: string | null } {
  const idx = MOCK_AUDITS.findIndex((a) => a.id === currentId);
  return {
    prevId: idx > 0 ? MOCK_AUDITS[idx - 1].id : null,
    nextId: idx >= 0 && idx < MOCK_AUDITS.length - 1 ? MOCK_AUDITS[idx + 1].id : null,
  };
}
