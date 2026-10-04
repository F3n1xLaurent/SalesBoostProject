-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN "waitingReminderSentAt" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "slaFirstResponseBreachedAt" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "slaResolutionBreachedAt" DATETIME;
