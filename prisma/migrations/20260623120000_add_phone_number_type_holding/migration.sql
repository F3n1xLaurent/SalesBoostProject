-- Add optional company binding for phone number types.
ALTER TABLE "phone_number_types" ADD COLUMN "holdingId" TEXT;

-- Preserve existing data by assigning current global types to the first company when one exists.
UPDATE "phone_number_types"
SET "holdingId" = (
  SELECT "id"
  FROM "holdings"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
WHERE "holdingId" IS NULL
  AND EXISTS (SELECT 1 FROM "holdings");

CREATE INDEX "phone_number_types_holdingId_idx" ON "phone_number_types"("holdingId");
