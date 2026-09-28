CREATE TABLE "evaluation_checklists" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdingId" TEXT,
    "name" TEXT NOT NULL,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "sourceTemplateId" TEXT,
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "evaluation_checklists_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "holdings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "evaluation_checklists_holdingId_isArchived_updatedAt_idx" ON "evaluation_checklists"("holdingId", "isArchived", "updatedAt");
CREATE INDEX "evaluation_checklists_isTemplate_isArchived_idx" ON "evaluation_checklists"("isTemplate", "isArchived");

ALTER TABLE "call_scripts" ADD COLUMN "checklistId" TEXT REFERENCES "evaluation_checklists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "call_scripts_checklistId_idx" ON "call_scripts"("checklistId");
