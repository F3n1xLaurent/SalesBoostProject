import { prisma } from '../src/db';
import { syncVoximplantTransactions } from '../src/economics/providerCosts';

async function main(): Promise<void> {
  const days = Number.parseInt(process.argv[2] || '90', 10);
  const result = await syncVoximplantTransactions(Number.isFinite(days) ? days : 90);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
