-- Add an optional company description without touching existing rows.
ALTER TABLE "holdings" ADD COLUMN "description" TEXT;
