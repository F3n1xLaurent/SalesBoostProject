CREATE TABLE "trainer_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "employeeId" TEXT NOT NULL,
  "branchId" TEXT,
  "companyId" TEXT,
  "sessionType" TEXT NOT NULL,
  "scenarioId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "difficulty" TEXT NOT NULL DEFAULT 'medium',
  "clientType" TEXT,
  "caseContextJson" TEXT NOT NULL DEFAULT '{}',
  "transcriptJson" TEXT NOT NULL DEFAULT '[]',
  "evaluationJson" TEXT,
  "dimensionsJson" TEXT,
  "checklistResultsJson" TEXT,
  "objectionsAnalysisJson" TEXT,
  "topRecommendationsJson" TEXT,
  "score" REAL,
  "baseScore" REAL,
  "multiplier" REAL NOT NULL DEFAULT 1,
  "finalPoints" INTEGER,
  "durationSec" INTEGER,
  "failureReason" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "trainer_sessions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "manager_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "dealerships" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "trainer_sessions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "holdings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "trainer_sessions_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "call_scripts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "trainer_scores" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "employeeId" TEXT NOT NULL,
  "trainerSessionId" TEXT NOT NULL,
  "baseScore" REAL NOT NULL,
  "multiplier" REAL NOT NULL,
  "finalScore" INTEGER NOT NULL,
  "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trainer_scores_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "manager_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_scores_trainerSessionId_fkey" FOREIGN KEY ("trainerSessionId") REFERENCES "trainer_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "trainer_streaks" (
  "employeeId" TEXT NOT NULL PRIMARY KEY,
  "currentStreak" INTEGER NOT NULL DEFAULT 0,
  "longestStreak" INTEGER NOT NULL DEFAULT 0,
  "lastActiveDate" TEXT,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "trainer_streaks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "manager_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "trainer_daily_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "employeeId" TEXT NOT NULL,
  "companyId" TEXT,
  "branchId" TEXT,
  "planDate" TEXT NOT NULL,
  "sessionsJson" TEXT NOT NULL DEFAULT '[]',
  "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "trainer_daily_plans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "manager_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trainer_daily_plans_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "holdings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "trainer_daily_plans_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "dealerships" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "trainer_sessions_employeeId_startedAt_idx" ON "trainer_sessions"("employeeId", "startedAt");
CREATE INDEX "trainer_sessions_branchId_startedAt_idx" ON "trainer_sessions"("branchId", "startedAt");
CREATE INDEX "trainer_sessions_companyId_startedAt_idx" ON "trainer_sessions"("companyId", "startedAt");
CREATE INDEX "trainer_sessions_scenarioId_startedAt_idx" ON "trainer_sessions"("scenarioId", "startedAt");
CREATE INDEX "trainer_sessions_sessionType_status_idx" ON "trainer_sessions"("sessionType", "status");

CREATE UNIQUE INDEX "trainer_scores_trainerSessionId_key" ON "trainer_scores"("trainerSessionId");
CREATE INDEX "trainer_scores_employeeId_earnedAt_idx" ON "trainer_scores"("employeeId", "earnedAt");

CREATE UNIQUE INDEX "trainer_daily_plans_employeeId_planDate_key" ON "trainer_daily_plans"("employeeId", "planDate");
CREATE INDEX "trainer_daily_plans_companyId_planDate_idx" ON "trainer_daily_plans"("companyId", "planDate");
CREATE INDEX "trainer_daily_plans_branchId_planDate_idx" ON "trainer_daily_plans"("branchId", "planDate");
