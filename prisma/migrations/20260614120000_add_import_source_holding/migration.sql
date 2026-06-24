ALTER TABLE "import_sources" ADD COLUMN "holdingId" TEXT;

CREATE INDEX "import_sources_holdingId_idx" ON "import_sources"("holdingId");
