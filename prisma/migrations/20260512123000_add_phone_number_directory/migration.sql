CREATE TABLE "phone_number_types" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "ownership" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "phone_numbers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "typeId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "dealershipId" TEXT,
  "accountId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "phone_numbers_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "phone_number_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "phone_numbers_dealershipId_fkey" FOREIGN KEY ("dealershipId") REFERENCES "dealerships" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "phone_numbers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "phone_number_types_ownership_isActive_idx" ON "phone_number_types"("ownership", "isActive");
CREATE INDEX "phone_numbers_typeId_idx" ON "phone_numbers"("typeId");
CREATE INDEX "phone_numbers_dealershipId_idx" ON "phone_numbers"("dealershipId");
CREATE INDEX "phone_numbers_accountId_idx" ON "phone_numbers"("accountId");
