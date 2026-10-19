ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionSource" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionReason" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionConfidence" REAL;
ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionIntroducedName" TEXT;
ALTER TABLE "voice_call_sessions" ADD COLUMN "attributionEvidence" TEXT;
