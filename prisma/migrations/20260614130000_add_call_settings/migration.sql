-- Persist call settings entities per company.
CREATE TABLE "call_customer_profiles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "holdingId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL,
  "age" INTEGER NOT NULL,
  "character" TEXT NOT NULL DEFAULT '',
  "temperament" TEXT NOT NULL,
  "patience" TEXT NOT NULL,
  "replyLength" TEXT NOT NULL,
  "communicationStyle" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "call_customer_profiles_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "call_scripts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "holdingId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "profileIdsJson" TEXT NOT NULL DEFAULT '[]',
  "context" TEXT NOT NULL DEFAULT '',
  "dataConditionJson" TEXT NOT NULL DEFAULT '{}',
  "objectionsJson" TEXT NOT NULL DEFAULT '[]',
  "questionsJson" TEXT NOT NULL DEFAULT '[]',
  "successCriteriaJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "call_scripts_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "call_customer_profiles_holdingId_updatedAt_idx" ON "call_customer_profiles"("holdingId", "updatedAt");
CREATE INDEX "call_scripts_holdingId_updatedAt_idx" ON "call_scripts"("holdingId", "updatedAt");
