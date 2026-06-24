CREATE TABLE `call_customer_voices` (
  `id` TEXT NOT NULL PRIMARY KEY,
  `name` TEXT NOT NULL,
  `elevenLabsCode` TEXT,
  `openaiCode` TEXT,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL
);

CREATE INDEX `call_customer_voices_isEnabled_name_idx` ON `call_customer_voices`(`isEnabled`, `name`);

INSERT INTO `call_customer_voices` (`id`, `name`, `elevenLabsCode`, `openaiCode`, `isEnabled`, `createdAt`, `updatedAt`)
VALUES
  ('marin', 'Естественный', NULL, 'shimmer', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cedar', 'Тёплый', NULL, 'alloy', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sage', 'Спокойный', NULL, 'sage', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ash', 'Мягкий', NULL, 'ash', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verse', 'Разговорный', NULL, 'verse', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('coral', 'Живой', NULL, 'coral', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('nova', 'Энергичный', NULL, 'nova', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('echo', 'Уверенный', NULL, 'echo', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
