import { prisma } from '../src/db';
import { refreshProxyApiTariffs } from '../src/economics/proxyApiTariffs';

async function main() {
  const result = await refreshProxyApiTariffs();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

