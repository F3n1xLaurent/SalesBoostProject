-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN "publicAccessTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_publicAccessTokenHash_key" ON "support_tickets"("publicAccessTokenHash");
