import type { PrismaClient } from '@prisma/client';

export type ProblemCatalogCategory = 'Контакт' | 'Диагностика' | 'Продукт' | 'Закрытие' | 'Коммуникация';

export type ProblemCatalogItem = {
  code: string;
  title: string;
  category: ProblemCatalogCategory;
  sortOrder: number;
};

export const DEFAULT_CALL_REPORT_PROBLEMS: ProblemCatalogItem[] = [
  { code: 'NO_INTRO_COMPANY', title: 'Не представился / не назвал компанию', category: 'Контакт', sortOrder: 10 },
  { code: 'NO_CLIENT_NAME', title: 'Не уточнил / не подтвердил имя клиента', category: 'Контакт', sortOrder: 20 },
  { code: 'WEAK_DIALOG_OPENING', title: 'Не открыл диалог грамотно после приветствия (сухо передал слово клиенту, не задал открывающий вопрос)', category: 'Контакт', sortOrder: 30 },
  { code: 'NO_NEEDS_DISCOVERY', title: 'Не выявил потребности клиента (поверхностные вопросы)', category: 'Диагностика', sortOrder: 40 },
  { code: 'NO_KEY_PARAMS', title: 'Не уточнил ключевые параметры (город, бюджет, сроки и т.п.)', category: 'Диагностика', sortOrder: 50 },
  { code: 'PRODUCT_MISINFORMATION', title: 'Слабое знание характеристик / фактическая ошибка (дезинформация)', category: 'Продукт', sortOrder: 60 },
  { code: 'WEAK_BENEFIT_PRESENTATION', title: 'Презентация не структурирована, нет акцента на выгодах', category: 'Продукт', sortOrder: 70 },
  { code: 'NO_DIRECT_ANSWER', title: 'Ушёл от вопроса клиента / не дал прямого ответа', category: 'Продукт', sortOrder: 80 },
  { code: 'WEAK_OBJECTION_HANDLING', title: 'Не отработал возражение / отработал слабо', category: 'Закрытие', sortOrder: 90 },
  { code: 'NO_NEXT_STEP', title: 'Не предложил следующий шаг', category: 'Закрытие', sortOrder: 100 },
  { code: 'NO_CONCRETE_NEXT_STEP', title: 'Следующий шаг без конкретики (нет даты/времени)', category: 'Закрытие', sortOrder: 110 },
  { code: 'PASSIVE_STYLE', title: 'Пассивный стиль, низкая вовлечённость', category: 'Коммуникация', sortOrder: 120 },
  { code: 'BAD_TONE', title: 'Грубый / неуважительный тон', category: 'Коммуникация', sortOrder: 130 },
  { code: 'MONOLOGUE', title: 'Монолог, не даёт клиенту говорить', category: 'Коммуникация', sortOrder: 140 },
  { code: 'INTERRUPTS_CLIENT', title: 'Перебивает клиента', category: 'Коммуникация', sortOrder: 150 },
  { code: 'CRITICAL_VIOLATION', title: 'Критическое нарушение (мат / дезинформация / редирект на сайт вместо работы с клиентом)', category: 'Коммуникация', sortOrder: 160 },
];

export async function seedCallReportProblemCatalog(prisma: PrismaClient): Promise<number> {
  let changed = 0;
  for (const problem of DEFAULT_CALL_REPORT_PROBLEMS) {
    await prisma.callReportProblem.upsert({
      where: { code: problem.code },
      create: { ...problem },
      update: {
        title: problem.title,
        category: problem.category,
        sortOrder: problem.sortOrder,
        isActive: true,
      },
    });
    changed += 1;
  }
  return changed;
}

export async function getCallReportProblemCatalog(prisma: PrismaClient): Promise<ProblemCatalogItem[]> {
  const rows = await prisma.callReportProblem.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
  });
  if (!rows.length) {
    await seedCallReportProblemCatalog(prisma);
    return DEFAULT_CALL_REPORT_PROBLEMS;
  }
  return rows.map((row) => ({
    code: row.code,
    title: row.title,
    category: row.category as ProblemCatalogCategory,
    sortOrder: row.sortOrder,
  }));
}

export function problemByTitle(catalog: ProblemCatalogItem[], title: unknown): ProblemCatalogItem | null {
  const normalized = String(title ?? '').trim().toLowerCase();
  if (!normalized) return null;
  return catalog.find((problem) => problem.title.toLowerCase() === normalized)
    ?? catalog.find((problem) => normalized.includes(problem.title.toLowerCase()) || problem.title.toLowerCase().includes(normalized))
    ?? null;
}
