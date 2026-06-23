CREATE TABLE "dealership_directions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "holdingId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dealership_directions_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "dealership_directions_holdingId_name_key" ON "dealership_directions"("holdingId", "name");
CREATE UNIQUE INDEX "dealership_directions_holdingId_code_key" ON "dealership_directions"("holdingId", "code");
CREATE INDEX "dealership_directions_holdingId_isActive_idx" ON "dealership_directions"("holdingId", "isActive");

INSERT INTO "dealership_directions" ("id", "holdingId", "name", "code", "isActive", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), "id", 'Новые автомобили', 'new_cars', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "holdings";

INSERT INTO "dealership_directions" ("id", "holdingId", "name", "code", "isActive", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), "id", 'Автомобили с пробегом', 'used_cars', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "holdings";
