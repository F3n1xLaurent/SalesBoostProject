ALTER TABLE "cost_events" ADD COLUMN "includedInTotals" BOOLEAN NOT NULL DEFAULT true;

-- Existing Voximplant call-history rows are allocations to individual calls.
-- Account transaction rows imported after this migration are the source of truth for totals.
UPDATE "cost_events"
SET "includedInTotals" = false
WHERE "provider" = 'voximplant';
