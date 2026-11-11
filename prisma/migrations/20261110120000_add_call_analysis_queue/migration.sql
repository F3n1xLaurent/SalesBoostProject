CREATE TABLE "call_analysis_jobs" (
    "callId" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "call_analysis_jobs_status_queuedAt_idx" ON "call_analysis_jobs"("status", "queuedAt");
