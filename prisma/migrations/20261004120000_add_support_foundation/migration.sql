-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "requesterAccountId" TEXT,
    "assigneeAccountId" TEXT,
    "holdingId" TEXT,
    "dealershipId" TEXT,
    "requesterName" TEXT,
    "requesterEmail" TEXT,
    "requesterPhone" TEXT,
    "requesterVerified" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT NOT NULL DEFAULT 'product',
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'P3',
    "status" TEXT NOT NULL DEFAULT 'new',
    "subject" TEXT,
    "escalationLevel" TEXT,
    "escalationReason" TEXT,
    "isEscalated" BOOLEAN NOT NULL DEFAULT false,
    "firstMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstResponseAt" DATETIME,
    "waitingSince" DATETIME,
    "holdSince" DATETIME,
    "resolvedAt" DATETIME,
    "closedAt" DATETIME,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerLastReadAt" DATETIME,
    "supportLastReadAt" DATETIME,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "slaFirstResponseMinutes" INTEGER,
    "slaResolutionMinutes" INTEGER,
    "bitrixDealId" TEXT,
    "bitrixChatId" TEXT,
    "bitrixSessionId" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastSyncedAt" DATETIME,
    "syncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "support_tickets_requesterAccountId_fkey" FOREIGN KEY ("requesterAccountId") REFERENCES "accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "support_tickets_assigneeAccountId_fkey" FOREIGN KEY ("assigneeAccountId") REFERENCES "accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "support_tickets_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "support_tickets_dealershipId_fkey" FOREIGN KEY ("dealershipId") REFERENCES "dealerships" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "authorAccountId" TEXT,
    "authorType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'product',
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "body" TEXT NOT NULL,
    "bitrixMessageId" TEXT,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "deliveryError" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "support_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "support_messages_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "support_message_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "support_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "support_ticket_status_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "changedByAccountId" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'product',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_status_history_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "support_ticket_status_history_changedByAccountId_fkey" FOREIGN KEY ("changedByAccountId") REFERENCES "accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "support_ticket_ratings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "authorAccountId" TEXT,
    "isSatisfied" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "support_ticket_ratings_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "support_ticket_ratings_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "support_integration_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "deduplicationKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "support_integration_outbox_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_number_key" ON "support_tickets"("number");
CREATE UNIQUE INDEX "support_tickets_bitrixDealId_key" ON "support_tickets"("bitrixDealId");
CREATE INDEX "support_tickets_requesterAccountId_updatedAt_idx" ON "support_tickets"("requesterAccountId", "updatedAt");
CREATE INDEX "support_tickets_assigneeAccountId_status_updatedAt_idx" ON "support_tickets"("assigneeAccountId", "status", "updatedAt");
CREATE INDEX "support_tickets_holdingId_status_updatedAt_idx" ON "support_tickets"("holdingId", "status", "updatedAt");
CREATE INDEX "support_tickets_dealershipId_status_updatedAt_idx" ON "support_tickets"("dealershipId", "status", "updatedAt");
CREATE INDEX "support_tickets_status_priority_updatedAt_idx" ON "support_tickets"("status", "priority", "updatedAt");
CREATE INDEX "support_tickets_bitrixChatId_idx" ON "support_tickets"("bitrixChatId");
CREATE INDEX "support_tickets_bitrixSessionId_idx" ON "support_tickets"("bitrixSessionId");
CREATE UNIQUE INDEX "support_messages_bitrixMessageId_key" ON "support_messages"("bitrixMessageId");
CREATE INDEX "support_messages_ticketId_sentAt_idx" ON "support_messages"("ticketId", "sentAt");
CREATE INDEX "support_messages_authorAccountId_sentAt_idx" ON "support_messages"("authorAccountId", "sentAt");
CREATE INDEX "support_messages_deliveryStatus_createdAt_idx" ON "support_messages"("deliveryStatus", "createdAt");
CREATE INDEX "support_message_attachments_messageId_idx" ON "support_message_attachments"("messageId");
CREATE INDEX "support_ticket_status_history_ticketId_createdAt_idx" ON "support_ticket_status_history"("ticketId", "createdAt");
CREATE INDEX "support_ticket_status_history_toStatus_createdAt_idx" ON "support_ticket_status_history"("toStatus", "createdAt");
CREATE UNIQUE INDEX "support_ticket_ratings_ticketId_key" ON "support_ticket_ratings"("ticketId");
CREATE INDEX "support_ticket_ratings_authorAccountId_createdAt_idx" ON "support_ticket_ratings"("authorAccountId", "createdAt");
CREATE UNIQUE INDEX "support_integration_outbox_deduplicationKey_key" ON "support_integration_outbox"("deduplicationKey");
CREATE INDEX "support_integration_outbox_status_nextAttemptAt_idx" ON "support_integration_outbox"("status", "nextAttemptAt");
CREATE INDEX "support_integration_outbox_ticketId_createdAt_idx" ON "support_integration_outbox"("ticketId", "createdAt");
