ALTER TABLE "voice_call_sessions" ADD COLUMN "voxSessionId" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "recordingStatus" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "recordingUrl" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "voxRecordId" TEXT;

CREATE INDEX "voice_call_sessions_voxSessionId_idx" ON "voice_call_sessions"("voxSessionId");
