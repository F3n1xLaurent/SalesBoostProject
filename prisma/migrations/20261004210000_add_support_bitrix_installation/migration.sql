CREATE TABLE "support_bitrix_installations" (
    "memberId" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "clientEndpoint" TEXT NOT NULL,
    "serverEndpoint" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenExpiresAt" DATETIME NOT NULL,
    "applicationTokenHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "support_bitrix_installations_status_updatedAt_idx"
ON "support_bitrix_installations"("status", "updatedAt");
