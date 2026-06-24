-- Store per-plan call history and prompt/evaluation snapshots.
CREATE TABLE "call_plan_calls" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "planId" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "employeeId" TEXT,
  "employeeName" TEXT,
  "dealershipId" TEXT,
  "dealershipName" TEXT,
  "phone" TEXT NOT NULL,
  "phoneNumberTypeId" TEXT NOT NULL,
  "scriptId" TEXT NOT NULL,
  "profileId" TEXT,
  "importedItemId" TEXT,
  "promptText" TEXT NOT NULL,
  "criteriaJson" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'running',
  "outcome" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" DATETIME,
  "transcriptJson" TEXT,
  "evaluationJson" TEXT,
  "totalScore" REAL,
  "failureReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "call_plan_calls_planId_fkey" FOREIGN KEY ("planId") REFERENCES "call_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "call_plan_calls_callId_key" ON "call_plan_calls"("callId");
CREATE INDEX "call_plan_calls_planId_startedAt_idx" ON "call_plan_calls"("planId", "startedAt");
