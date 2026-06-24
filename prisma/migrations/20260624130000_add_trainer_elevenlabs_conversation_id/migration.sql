ALTER TABLE `trainer_sessions`
  ADD COLUMN `elevenLabsConversationId` TEXT;

CREATE INDEX `trainer_sessions_elevenLabsConversationId_idx` ON `trainer_sessions`(`elevenLabsConversationId`);
