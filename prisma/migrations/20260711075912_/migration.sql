-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_call_report_problem_catalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_call_report_problem_catalog" ("category", "code", "createdAt", "id", "isActive", "sortOrder", "title", "updatedAt") SELECT "category", "code", "createdAt", "id", "isActive", "sortOrder", "title", "updatedAt" FROM "call_report_problem_catalog";
DROP TABLE "call_report_problem_catalog";
ALTER TABLE "new_call_report_problem_catalog" RENAME TO "call_report_problem_catalog";
CREATE UNIQUE INDEX "call_report_problem_catalog_code_key" ON "call_report_problem_catalog"("code");
CREATE INDEX "call_report_problem_catalog_isActive_sortOrder_idx" ON "call_report_problem_catalog"("isActive", "sortOrder");
CREATE INDEX "call_report_problem_catalog_category_idx" ON "call_report_problem_catalog"("category");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
