ALTER TABLE "dealerships" ADD COLUMN "workingHoursFrom" TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE "dealerships" ADD COLUMN "workingHoursTo" TEXT NOT NULL DEFAULT '21:00';
