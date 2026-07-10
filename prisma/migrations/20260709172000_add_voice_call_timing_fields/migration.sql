ALTER TABLE "voice_call_sessions" ADD COLUMN "connectedAt" DATETIME;
ALTER TABLE "voice_call_sessions" ADD COLUMN "answerTimeSec" INTEGER;
ALTER TABLE "voice_call_sessions" ADD COLUMN "talkDurationSec" INTEGER;
