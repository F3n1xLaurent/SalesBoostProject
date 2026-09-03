ALTER TABLE "call_plans" ADD COLUMN "targetPhoneScope" TEXT NOT NULL DEFAULT 'employees';
ALTER TABLE "call_plans" ADD COLUMN "employeePhoneNumberTypeId" TEXT;
ALTER TABLE "call_plans" ADD COLUMN "dealershipPhoneNumberTypeId" TEXT;

UPDATE "call_plans"
SET "employeePhoneNumberTypeId" = "phoneNumberTypeId";

ALTER TABLE "call_plan_calls" ADD COLUMN "phoneNumberId" TEXT;
ALTER TABLE "call_plan_calls" ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'employee';

CREATE INDEX "call_plan_calls_planId_phoneNumberId_scheduledAt_idx"
  ON "call_plan_calls"("planId", "phoneNumberId", "scheduledAt");

ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionType" TEXT;

UPDATE "voice_call_sessions"
SET "attributionType" = CASE
  WHEN "managerId" IS NOT NULL THEN 'manager'
  WHEN "dealershipId" IS NOT NULL THEN 'dealership'
  ELSE NULL
END;
