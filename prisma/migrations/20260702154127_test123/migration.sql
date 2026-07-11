-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_city_dictionary" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "searchName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_city_dictionary" ("createdAt", "id", "name", "searchName", "updatedAt") SELECT "createdAt", "id", "name", "searchName", "updatedAt" FROM "city_dictionary";
DROP TABLE "city_dictionary";
ALTER TABLE "new_city_dictionary" RENAME TO "city_dictionary";
CREATE UNIQUE INDEX "city_dictionary_name_key" ON "city_dictionary"("name");
CREATE INDEX "city_dictionary_searchName_idx" ON "city_dictionary"("searchName");
CREATE TABLE "new_dealership_directions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dealership_directions_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_dealership_directions" ("code", "createdAt", "holdingId", "id", "isActive", "name", "updatedAt") SELECT "code", "createdAt", "holdingId", "id", "isActive", "name", "updatedAt" FROM "dealership_directions";
DROP TABLE "dealership_directions";
ALTER TABLE "new_dealership_directions" RENAME TO "dealership_directions";
CREATE INDEX "dealership_directions_holdingId_isActive_idx" ON "dealership_directions"("holdingId", "isActive");
CREATE UNIQUE INDEX "dealership_directions_holdingId_name_key" ON "dealership_directions"("holdingId", "name");
CREATE UNIQUE INDEX "dealership_directions_holdingId_code_key" ON "dealership_directions"("holdingId", "code");
CREATE TABLE "new_import_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "schedule" TEXT,
    "itemsPath" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "aiConfigJson" TEXT NOT NULL,
    "tagRulesJson" TEXT NOT NULL DEFAULT '[]',
    "lastRunAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "import_sources_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_import_sources" ("aiConfigJson", "createdAt", "entityType", "format", "holdingId", "id", "itemsPath", "lastError", "lastRunAt", "name", "schedule", "status", "tagRulesJson", "updatedAt", "url") SELECT "aiConfigJson", "createdAt", "entityType", "format", "holdingId", "id", "itemsPath", "lastError", "lastRunAt", "name", "schedule", "status", "tagRulesJson", "updatedAt", "url" FROM "import_sources";
DROP TABLE "import_sources";
ALTER TABLE "new_import_sources" RENAME TO "import_sources";
CREATE INDEX "import_sources_status_idx" ON "import_sources"("status");
CREATE INDEX "import_sources_holdingId_idx" ON "import_sources"("holdingId");
CREATE TABLE "new_imported_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importSourceId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rawDataJson" TEXT NOT NULL,
    "normalizedDataJson" TEXT NOT NULL,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "imported_items_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_imported_items" ("contentHash", "createdAt", "description", "externalId", "id", "importSourceId", "normalizedDataJson", "rawDataJson", "tagsJson", "title", "updatedAt") SELECT "contentHash", "createdAt", "description", "externalId", "id", "importSourceId", "normalizedDataJson", "rawDataJson", "tagsJson", "title", "updatedAt" FROM "imported_items";
DROP TABLE "imported_items";
ALTER TABLE "new_imported_items" RENAME TO "imported_items";
CREATE INDEX "imported_items_importSourceId_idx" ON "imported_items"("importSourceId");
CREATE INDEX "imported_items_externalId_idx" ON "imported_items"("externalId");
CREATE UNIQUE INDEX "imported_items_importSourceId_contentHash_key" ON "imported_items"("importSourceId", "contentHash");
CREATE TABLE "new_phone_number_types" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT,
    "name" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "phone_number_types_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_phone_number_types" ("createdAt", "holdingId", "id", "isActive", "name", "ownership", "updatedAt") SELECT "createdAt", "holdingId", "id", "isActive", "name", "ownership", "updatedAt" FROM "phone_number_types";
DROP TABLE "phone_number_types";
ALTER TABLE "new_phone_number_types" RENAME TO "phone_number_types";
CREATE INDEX "phone_number_types_holdingId_idx" ON "phone_number_types"("holdingId");
CREATE INDEX "phone_number_types_ownership_isActive_idx" ON "phone_number_types"("ownership", "isActive");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
