-- CreateTable
CREATE TABLE "billing_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT NOT NULL,
    "amountKopecks" INTEGER NOT NULL,
    "paidAt" DATETIME NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME,
    "calls" BOOLEAN NOT NULL DEFAULT false,
    "trainer" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "billing_payments_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "billing_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT NOT NULL,
    "paymentId" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_changes_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "billing_changes_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "billing_payments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Existing companies retain access until billing is explicitly enabled.
ALTER TABLE "holdings" ADD COLUMN "billingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "billing_payments_holdingId_status_startsAt_endsAt_idx" ON "billing_payments"("holdingId", "status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "billing_changes_holdingId_createdAt_idx" ON "billing_changes"("holdingId", "createdAt");

