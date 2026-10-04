CREATE TABLE "provider_balance_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "balance" REAL NOT NULL,
    "used" REAL,
    "limit" REAL,
    "unit" TEXT NOT NULL,
    "currency" TEXT,
    "balanceRub" REAL,
    "exchangeRateToRub" REAL,
    "exchangeRateDate" DATETIME,
    "exchangeRateSource" TEXT,
    "resetAt" DATETIME,
    "capturedHour" DATETIME NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "provider_balance_snapshots_provider_capturedHour_key"
ON "provider_balance_snapshots"("provider", "capturedHour");

CREATE INDEX "provider_balance_snapshots_provider_capturedAt_idx"
ON "provider_balance_snapshots"("provider", "capturedAt");
