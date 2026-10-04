CREATE TABLE "cost_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "stage" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "companyId" TEXT,
    "externalId" TEXT,
    "model" TEXT,
    "quantity" REAL,
    "quantityUnit" TEXT,
    "inputUnits" INTEGER,
    "outputUnits" INTEGER,
    "amountOriginal" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "amountRub" REAL,
    "exchangeRateToRub" REAL,
    "status" TEXT NOT NULL DEFAULT 'estimated',
    "rawJson" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "cost_events_provider_externalId_key" ON "cost_events"("provider", "externalId");
CREATE INDEX "cost_events_occurredAt_idx" ON "cost_events"("occurredAt");
CREATE INDEX "cost_events_provider_occurredAt_idx" ON "cost_events"("provider", "occurredAt");
CREATE INDEX "cost_events_entityType_entityId_idx" ON "cost_events"("entityType", "entityId");
CREATE INDEX "cost_events_companyId_occurredAt_idx" ON "cost_events"("companyId", "occurredAt");
