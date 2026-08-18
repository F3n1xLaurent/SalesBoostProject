ALTER TABLE "voice_call_sessions" ADD COLUMN "phoneNumberId" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "phoneNumberTypeId" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "phoneNumberTypeName" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "phoneNumberOwnership" TEXT;

CREATE INDEX "voice_call_sessions_phoneNumberTypeId_startedAt_idx"
  ON "voice_call_sessions"("phoneNumberTypeId", "startedAt");

CREATE INDEX "voice_call_sessions_phoneNumberOwnership_startedAt_idx"
  ON "voice_call_sessions"("phoneNumberOwnership", "startedAt");
