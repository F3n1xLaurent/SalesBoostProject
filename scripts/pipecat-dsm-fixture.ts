/** Read-only plan fixture: no phone targets, call archives or database writes. */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { prisma } from '../src/db';
import { buildRealtimeCallPrompt } from '../src/voice/callSettingsManagement';

async function main() {
  try {
    const plans = await prisma.callPlan.findMany({ where: { name: 'Демонстрационный план прозвона' } });
    if (plans.length !== 1) throw new Error('Expected exactly one demonstration plan');
    const plan = plans[0];
    const script = await prisma.callScript.findUniqueOrThrow({ where: { id: plan.scriptId } });
    const profileId = JSON.parse(script.profileIdsJson)[0];
    const profile = profileId ? await prisma.callCustomerProfile.findUniqueOrThrow({ where: { id: profileId } }) : null;
    // Freeze age and use fictitious listing/company; keep actual plan content.
    const fixedProfile = profile ? { ...profile, ageFrom: profile.age, ageTo: profile.age } : null;
    const fixture = {
      planId: plan.id, planName: plan.name, scriptUpdatedAt: script.updatedAt,
      syntheticListing: true, context: script.context,
      questions: JSON.parse(script.questionsJson), objections: JSON.parse(script.objectionsJson),
      profile: fixedProfile && { age: fixedProfile.age, temperament: fixedProfile.temperament,
        patience: fixedProfile.patience, replyLength: fixedProfile.replyLength, communicationStyle: fixedProfile.communicationStyle },
      prompt: buildRealtimeCallPrompt({ script, profile: fixedProfile,
        importedItem: { title: 'Лира Седан 2024', description: 'Вымышленный автомобиль для теста. Автоматическая коробка. Пробег 20000 км. Цена 1500000 рублей.' },
        holding: { name: 'Тестовый автосалон', description: '' }, clientName: 'Андрей' }),
    };
    mkdirSync('storage/pipecat-benchmarks/dsm', { recursive: true });
    writeFileSync('storage/pipecat-benchmarks/dsm/fixture.json', JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ plan: plan.name, promptChars: fixture.prompt.length, questions: fixture.questions.length, objections: fixture.objections.length }));
  } finally { await prisma.$disconnect(); }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
