ALTER TABLE "call_plans" ADD COLUMN "weekdaysJson" TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,0]';
ALTER TABLE "call_plan_calls" ADD COLUMN "scheduledAt" DATETIME;

UPDATE "call_plan_calls"
SET "scheduledAt" = "startedAt"
WHERE "scheduledAt" IS NULL;

CREATE INDEX "call_plan_calls_planId_scheduledAt_idx" ON "call_plan_calls"("planId", "scheduledAt");
CREATE INDEX "call_plan_calls_status_scheduledAt_idx" ON "call_plan_calls"("status", "scheduledAt");
