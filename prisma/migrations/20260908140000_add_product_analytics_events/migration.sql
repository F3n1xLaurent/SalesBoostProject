CREATE TABLE "product_analytics_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventName" TEXT NOT NULL,
    "accountId" TEXT,
    "role" TEXT,
    "holdingId" TEXT,
    "dealershipId" TEXT,
    "managerId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "route" TEXT,
    "clientSessionId" TEXT,
    "propertiesJson" TEXT NOT NULL DEFAULT '{}',
    "deduplicationKey" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "product_analytics_events_deduplicationKey_key"
ON "product_analytics_events"("deduplicationKey");

CREATE INDEX "product_analytics_events_eventName_occurredAt_idx"
ON "product_analytics_events"("eventName", "occurredAt");

CREATE INDEX "product_analytics_events_accountId_occurredAt_idx"
ON "product_analytics_events"("accountId", "occurredAt");

CREATE INDEX "product_analytics_events_role_occurredAt_idx"
ON "product_analytics_events"("role", "occurredAt");

CREATE INDEX "product_analytics_events_holdingId_occurredAt_idx"
ON "product_analytics_events"("holdingId", "occurredAt");

CREATE INDEX "product_analytics_events_dealershipId_occurredAt_idx"
ON "product_analytics_events"("dealershipId", "occurredAt");

CREATE INDEX "product_analytics_events_managerId_occurredAt_idx"
ON "product_analytics_events"("managerId", "occurredAt");
