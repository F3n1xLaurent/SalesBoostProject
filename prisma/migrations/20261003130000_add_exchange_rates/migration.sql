ALTER TABLE "cost_events" ADD COLUMN "exchangeRateDate" DATETIME;
ALTER TABLE "cost_events" ADD COLUMN "exchangeRateSource" TEXT;

CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL DEFAULT 'RUB',
    "rate" REAL NOT NULL,
    "rateDate" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'cbr',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "exchange_rates_baseCurrency_quoteCurrency_rateDate_source_key"
ON "exchange_rates"("baseCurrency", "quoteCurrency", "rateDate", "source");
CREATE INDEX "exchange_rates_baseCurrency_quoteCurrency_rateDate_idx"
ON "exchange_rates"("baseCurrency", "quoteCurrency", "rateDate");
