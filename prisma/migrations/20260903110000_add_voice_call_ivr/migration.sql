ALTER TABLE "voice_call_sessions" ADD COLUMN "ivrDetected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "voice_call_sessions" ADD COLUMN "ivrPathJson" TEXT;
