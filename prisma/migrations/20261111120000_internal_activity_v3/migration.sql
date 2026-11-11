ALTER TABLE "holdings" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_analytics_events" ADD COLUMN "initiatedBy" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "product_analytics_events" RENAME COLUMN "holdingId" TO "companyId";
ALTER TABLE "product_analytics_events" RENAME COLUMN "dealershipId" TO "branchId";
ALTER TABLE "product_analytics_events" RENAME COLUMN "managerId" TO "employeeId";
UPDATE "product_analytics_events" SET "initiatedBy" = 'system' WHERE "eventName" IN ('call_check_completed', 'call_processing_failed');
DELETE FROM "product_analytics_events" WHERE "eventName" = 'score_viewed' OR ("eventName" = 'recommendations_viewed' AND json_valid("propertiesJson") AND json_extract("propertiesJson", '$.surface') = 'recommendations_block');
UPDATE "product_analytics_events" SET "eventName" = CASE "eventName" WHEN 'manager_viewed' THEN 'employee_viewed' WHEN 'dealership_viewed' THEN 'branch_viewed' WHEN 'errors_viewed' THEN 'report_findings_opened' WHEN 'recommendations_viewed' THEN 'report_recommendations_opened' ELSE "eventName" END;
UPDATE "product_analytics_events" SET "role" = CASE "role" WHEN 'manager' THEN 'employee' WHEN 'holding_admin' THEN 'company_admin' WHEN 'dealership_admin' THEN 'branch_admin' WHEN 'platform_superadmin' THEN 'superadmin' ELSE "role" END;
UPDATE "product_analytics_events" SET "targetType" = CASE "targetType" WHEN 'manager' THEN 'employee' WHEN 'dealership' THEN 'branch' WHEN 'holding' THEN 'company' ELSE "targetType" END;
UPDATE "product_analytics_events" SET "propertiesJson" = json_set("propertiesJson", '$.report_type', 'training') WHERE json_valid("propertiesJson") AND json_extract("propertiesJson", '$.report_type') = 'trainer';
CREATE INDEX "product_analytics_events_initiatedBy_occurredAt_idx" ON "product_analytics_events"("initiatedBy", "occurredAt");
DROP INDEX IF EXISTS "product_analytics_events_holdingId_occurredAt_idx";
DROP INDEX IF EXISTS "product_analytics_events_dealershipId_occurredAt_idx";
DROP INDEX IF EXISTS "product_analytics_events_managerId_occurredAt_idx";
CREATE INDEX "product_analytics_events_companyId_occurredAt_idx" ON "product_analytics_events"("companyId", "occurredAt");
CREATE INDEX "product_analytics_events_branchId_occurredAt_idx" ON "product_analytics_events"("branchId", "occurredAt");
CREATE INDEX "product_analytics_events_employeeId_occurredAt_idx" ON "product_analytics_events"("employeeId", "occurredAt");
-- Preserve historical section/report breakdowns and expose neutral property names.
UPDATE "product_analytics_events" SET "propertiesJson" = json_remove(json_set(
  CASE WHEN json_valid("propertiesJson") THEN "propertiesJson" ELSE '{}' END,
  '$.company_id', "companyId", '$.branch_id', "branchId", '$.employee_id', "employeeId",
  '$.role', "role", '$.initiated_by', "initiatedBy",
  '$.company_name', (SELECT name FROM holdings WHERE id = "companyId"),
  '$.branch_name', (SELECT name FROM dealerships WHERE id = "branchId"),
  '$.is_test', json(CASE WHEN EXISTS (SELECT 1 FROM holdings WHERE id = "companyId" AND isTest = 1) THEN 'true' ELSE 'false' END)
), '$.holding_id', '$.dealership_id', '$.manager_id');
UPDATE "product_analytics_events" SET "propertiesJson" = json_set("propertiesJson", '$.section', CASE
  WHEN route = '/dashboard' OR route = '/' THEN 'dashboard'
  WHEN route LIKE '/analytics%' THEN 'analytics'
  WHEN route LIKE '/holdings%' THEN 'companies'
  WHEN route LIKE '/companies%' OR route LIKE '/dealer/companies%' THEN 'branches'
  WHEN route LIKE '/users%' OR route LIKE '/autodealers%' OR route LIKE '/dealer/team%' OR route LIKE '/dealer/employees%' THEN 'employees'
  WHEN route LIKE '/audits%' OR route LIKE '/dealer/calls%' THEN 'audits'
  WHEN route LIKE '/data%' OR route LIKE '/imports%' THEN 'data'
  WHEN route LIKE '/checklists%' THEN 'checklists'
  WHEN route LIKE '/dealership-directions%' THEN 'branch_directions'
  WHEN route LIKE '/typesNumbers%' THEN 'number_types'
  WHEN route LIKE '/call-settings/realtime-test%' OR route LIKE '/testing%' THEN 'testing'
  WHEN route LIKE '/call-settings%' THEN 'call_settings'
  WHEN route LIKE '/billing%' THEN 'billing'
  WHEN route LIKE '/staff/trainer%' OR route LIKE '/train%' THEN 'trainer'
  WHEN route LIKE '/staff/profile%' THEN 'profile'
  WHEN route LIKE '/internal-analytics%' THEN 'internal_analytics'
  WHEN route LIKE '/dictionaries%' THEN 'dictionaries'
  ELSE 'settings' END) WHERE eventName = 'page_viewed';
-- Older logins omitted the company although the branch was known.
UPDATE "product_analytics_events" SET "companyId" = (SELECT holdingId FROM dealerships WHERE id = "branchId") WHERE "companyId" IS NULL AND "branchId" IS NOT NULL;
UPDATE "product_analytics_events" SET "propertiesJson" = json_set("propertiesJson", '$.company_id', "companyId", '$.company_name', (SELECT name FROM holdings WHERE id = "companyId"));
