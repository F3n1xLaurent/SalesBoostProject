import { PrismaClient } from '@prisma/client';

// Keep the module tiny so tsx watch restarts cleanly after Prisma client regeneration.
export const prisma = new PrismaClient();
