CREATE TABLE "import_sources" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "import_sources_status_idx" ON "import_sources"("status");

CREATE TABLE "imported_items" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "imported_items_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "imported_items_importSourceId_contentHash_key" ON "imported_items"("importSourceId", "contentHash");
CREATE INDEX "imported_items_importSourceId_idx" ON "imported_items"("importSourceId");
CREATE INDEX "imported_items_externalId_idx" ON "imported_items"("externalId");

CREATE TABLE "import_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "importSourceId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  "totalItems" INTEGER NOT NULL DEFAULT 0,
  "createdItems" INTEGER NOT NULL DEFAULT 0,
  "updatedItems" INTEGER NOT NULL DEFAULT 0,
  "skippedItems" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  CONSTRAINT "import_runs_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "import_runs_importSourceId_startedAt_idx" ON "import_runs"("importSourceId", "startedAt");
