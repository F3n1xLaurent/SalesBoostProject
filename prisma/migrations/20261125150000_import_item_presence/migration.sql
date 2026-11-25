ALTER TABLE "imported_items" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "imported_items_importSourceId_isActive_idx" ON "imported_items"("importSourceId", "isActive");
