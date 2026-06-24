ALTER TABLE `call_customer_voices`
  ADD COLUMN `isDeleted` BOOLEAN NOT NULL DEFAULT false;

DROP INDEX `call_customer_voices_isEnabled_name_idx`;

CREATE INDEX `call_customer_voices_isDeleted_isEnabled_name_idx` ON `call_customer_voices`(`isDeleted`, `isEnabled`, `name`);
