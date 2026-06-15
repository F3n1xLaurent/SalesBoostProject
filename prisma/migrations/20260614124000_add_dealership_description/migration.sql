-- Add an optional dealership description without touching existing rows.
ALTER TABLE "dealerships" ADD COLUMN "description" TEXT;
