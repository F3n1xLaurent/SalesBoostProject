CREATE TABLE IF NOT EXISTS "city_dictionary" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "searchName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "city_dictionary_name_key" ON "city_dictionary"("name");
CREATE INDEX IF NOT EXISTS "city_dictionary_searchName_idx" ON "city_dictionary"("searchName");
