ALTER TABLE "support_tickets" ADD COLUMN "bitrixContactId" TEXT;

CREATE INDEX "support_tickets_bitrixContactId_idx"
ON "support_tickets"("bitrixContactId");
