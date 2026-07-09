import { PrismaClient } from '@prisma/client';
import { SYSTEM_PERMISSION_TEMPLATES } from '../src/auth/permissions';
import { seedCityDictionaryIfNeeded } from '../src/data/cityDictionary';
import { seedCallReportProblemCatalog } from '../src/voice/problemCatalog';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const seededCities = await seedCityDictionaryIfNeeded(prisma);
  if (seededCities > 0) {
    console.log(`Seeded city dictionary with ${seededCities} new cities.`);
  } else {
    console.log('City dictionary is already complete, skipping seed.');
  }

  const syncedProblems = await seedCallReportProblemCatalog(prisma);
  console.log(`Synced call report problem catalog with ${syncedProblems} items.`);

  await Promise.all(
    SYSTEM_PERMISSION_TEMPLATES.map((template) =>
      prisma.permissionTemplate.upsert({
        where: { name: template.name },
        create: {
          name: template.name,
          description: template.description,
          permissionsJson: JSON.stringify(template.permissions),
          isSystem: true,
        },
        update: {
          description: template.description,
          permissionsJson: JSON.stringify(template.permissions),
          isSystem: true,
        },
      }),
    ),
  );
  console.log(`Synced ${SYSTEM_PERMISSION_TEMPLATES.length} system permission templates`);

  // Check if test already exists
  const existingTest = await prisma.test.findFirst({
    where: { isActive: true },
  });

  if (existingTest) {
    console.log('Test already exists, skipping seed.');
    return;
  }

  // Create test
  const test = await prisma.test.create({
    data: {
      title: 'Тест продаж автомобилей',
      isActive: true,
      steps: {
        create: [
          {
            order: 1,
            customerMessage: 'Здравствуйте! Я интересуюсь покупкой автомобиля. Можете рассказать, какие модели у вас есть в наличии?',
            stepGoal: 'Initial contact - establish rapport, show interest, gather initial information about customer needs',
            scoringFocusJson: JSON.stringify(['STRUCTURE', 'EMPATHY_TONE', 'NEEDS_DISCOVERY']),
          },
          {
            order: 2,
            customerMessage: 'Хорошо, а какая цена на эту модель? Это довольно дорого... Может быть, есть что-то подешевле?',
            stepGoal: 'Price objection - handle price concern, provide value, explore alternatives without losing the sale',
            scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'VALUE_ARGUMENTATION', 'EMPATHY_TONE']),
          },
          {
            order: 3,
            customerMessage: 'Я слышал, что у конкурентов такая же машина стоит дешевле. Почему у вас дороже?',
            stepGoal: 'Competitor comparison - differentiate value, build trust, address comparison without badmouthing competitors',
            scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'VALUE_ARGUMENTATION', 'RISK_PHRASES']),
          },
          {
            order: 4,
            customerMessage: 'Хм, я не уверен. Мне нужно подумать. Может быть, я вернусь позже?',
            stepGoal: 'Hesitation/indecision - create urgency, address concerns, move toward commitment',
            scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'NEXT_STEP_CTA', 'EMPATHY_TONE']),
          },
          {
            order: 5,
            customerMessage: 'А как насчет гарантии? И что если что-то пойдет не так после покупки?',
            stepGoal: 'Trust and risk concerns - build confidence, address warranty and after-sale support',
            scoringFocusJson: JSON.stringify(['EMPATHY_TONE', 'VALUE_ARGUMENTATION', 'OBJECTION_HANDLING']),
          },
          {
            order: 6,
            customerMessage: 'Хорошо, допустим я готов купить. Что дальше? Какие документы нужны?',
            stepGoal: 'Closing readiness - provide clear next steps, make process easy, maintain momentum',
            scoringFocusJson: JSON.stringify(['NEXT_STEP_CTA', 'STRUCTURE', 'VALUE_ARGUMENTATION']),
          },
          {
            order: 7,
            customerMessage: 'Отлично! Можем ли мы записаться на тест-драйв на этой неделе?',
            stepGoal: 'Final commitment - confirm appointment, set expectations, ensure smooth transition',
            scoringFocusJson: JSON.stringify(['NEXT_STEP_CTA', 'STRUCTURE', 'EMPATHY_TONE']),
          },
        ],
      },
    },
    include: {
      steps: true,
    },
  });

  console.log(`Created test "${test.title}" with ${test.steps.length} steps`);

  // Create virtual customer test (inactive by default; set isActive: true to use it)
  const virtualConfig = {
    car: {
      brand: 'Toyota',
      model: 'Camry',
      year: 2023,
      price: 'от 3.2 млн',
      mileage: 'новый',
      description: 'Седан, полная комплектация',
    },
    dealership:
      'Осмотр автомобилей проводится в подземной парковке торгового центра в центре города. Удобная локация, можно совместить с походом по магазинам.',
  };
  await prisma.test.create({
    data: {
      title: 'Звонок виртуальному клиенту',
      isActive: false,
      useVirtualCustomer: true,
      virtualCustomerConfigJson: JSON.stringify(virtualConfig),
    },
  });
  console.log('Created virtual customer test (isActive: false). Set isActive: true in Prisma Studio to use it.');
}

main()
  .catch((e) => {
    console.error('Error seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
