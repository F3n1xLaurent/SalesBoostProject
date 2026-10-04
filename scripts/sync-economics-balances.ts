import { prisma } from '../src/db';
import { refreshProviderBalances } from '../src/economics/providerBalances';

async function main(): Promise<void> {
  const result = await refreshProviderBalances();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
