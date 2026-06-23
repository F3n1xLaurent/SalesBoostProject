-- Add optional analytics links to voice call sessions. Existing unlinked calls stay valid.
ALTER TABLE "voice_call_sessions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "voice_call_sessions" ADD COLUMN "dealershipId" TEXT REFERENCES "dealerships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voice_call_sessions" ADD COLUMN "managerId" TEXT REFERENCES "manager_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voice_call_sessions" ADD COLUMN "planId" TEXT REFERENCES "call_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voice_call_sessions" ADD COLUMN "dimensionsJson" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "checklistResultsJson" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "caseContextJson" TEXT;

CREATE INDEX "voice_call_sessions_dealershipId_startedAt_idx" ON "voice_call_sessions"("dealershipId", "startedAt");
CREATE INDEX "voice_call_sessions_managerId_startedAt_idx" ON "voice_call_sessions"("managerId", "startedAt");
CREATE INDEX "voice_call_sessions_planId_startedAt_idx" ON "voice_call_sessions"("planId", "startedAt");
CREATE INDEX "voice_call_sessions_source_startedAt_idx" ON "voice_call_sessions"("source", "startedAt");

UPDATE "voice_call_sessions"
SET
  "source" = 'scheduled',
  "dealershipId" = (
    SELECT "call_plan_calls"."dealershipId"
    FROM "call_plan_calls"
    WHERE "call_plan_calls"."callId" = "voice_call_sessions"."callId"
    LIMIT 1
  ),
  "managerId" = (
    SELECT "call_plan_calls"."employeeId"
    FROM "call_plan_calls"
    WHERE "call_plan_calls"."callId" = "voice_call_sessions"."callId"
    LIMIT 1
  ),
  "planId" = (
    SELECT "call_plan_calls"."planId"
    FROM "call_plan_calls"
    WHERE "call_plan_calls"."callId" = "voice_call_sessions"."callId"
    LIMIT 1
  ),
  "dimensionsJson" = json_extract("evaluationJson", '$.dimension_scores'),
  "checklistResultsJson" = json_extract("evaluationJson", '$.checklist')
WHERE EXISTS (
  SELECT 1
  FROM "call_plan_calls"
  WHERE "call_plan_calls"."callId" = "voice_call_sessions"."callId"
);

UPDATE "voice_call_sessions"
SET
  "dimensionsJson" = json_extract("evaluationJson", '$.dimension_scores'),
  "checklistResultsJson" = json_extract("evaluationJson", '$.checklist')
WHERE "evaluationJson" IS NOT NULL
  AND ("dimensionsJson" IS NULL OR "checklistResultsJson" IS NULL);
