ALTER TABLE `call_customer_profiles`
  ADD COLUMN `ageFrom` INTEGER NOT NULL DEFAULT 35;

ALTER TABLE `call_customer_profiles`
  ADD COLUMN `ageTo` INTEGER NOT NULL DEFAULT 35;

UPDATE `call_customer_profiles`
SET `ageFrom` = `age`,
    `ageTo` = `age`;
