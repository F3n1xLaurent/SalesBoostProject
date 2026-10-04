ALTER TABLE "cost_events" ADD COLUMN "tariffId" TEXT;
ALTER TABLE "cost_events" ADD COLUMN "tariffEffectiveAt" DATETIME;

CREATE TABLE "provider_tariffs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "ratesJson" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "effectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "provider_tariffs_provider_model_rawHash_key"
ON "provider_tariffs"("provider", "model", "rawHash");
CREATE INDEX "provider_tariffs_provider_model_effectiveAt_idx"
ON "provider_tariffs"("provider", "model", "effectiveAt");
