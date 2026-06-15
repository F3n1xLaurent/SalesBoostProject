-- Persist scheduled call plans per company.
CREATE TABLE "call_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "holdingId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetIdsJson" TEXT NOT NULL DEFAULT '[]',
  "scriptId" TEXT NOT NULL,
  "phoneNumberTypeId" TEXT NOT NULL,
  "frequency" TEXT NOT NULL,
  "callTimeFrom" TEXT NOT NULL,
  "callTimeTo" TEXT NOT NULL,
  "lastInitiatedAt" DATETIME,
  "lastBatchId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "call_plans_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "call_plans_holdingId_updatedAt_idx" ON "call_plans"("holdingId", "updatedAt");
