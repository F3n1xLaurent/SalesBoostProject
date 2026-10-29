# Гипотеза 2: GPT Realtime + ElevenLabs TTS

Контур изолирован от рабочих звонков и первой realtime-гипотезы:

`Voximplant → backend → CometAPI или OpenAI GPT Realtime (text) → ElevenLabs Streaming TTS → Voximplant → телефон`

## Настройка

1. На backend задать `COMETAPI_API_KEY`. Остальные значения имеют безопасные тестовые defaults:

   ```env
   COMETAPI_REALTIME_MODEL=gpt-realtime-2
   COMETAPI_REALTIME_URL=wss://api.cometapi.com/v1/realtime
   COMETAPI_REALTIME_REASONING_EFFORT=low
   COMETAPI_REALTIME_ENDPOINT_SILENCE_MS=350
   COMETAPI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
   ```

2. Проверить соединение без звонка:

   ```bash
   npm run check-comet-realtime
   ```

   Для прямого OpenAI добавить отдельный ключ и выполнить:

   ```env
   OPENAI_REALTIME_API_KEY=sk-...
   OPENAI_REALTIME_MODEL=gpt-realtime-2
   ```

   ```bash
   npm run check-openai-realtime
   ```

3. В Voximplant создать сценарий `voice_comet_realtime_test` из файла
   `voximplant/scenario_voice_comet_realtime_test.js`.

4. Создать правило `voice_comet_realtime_test_rule`, привязать к нему новый сценарий.
   Имена можно переопределить через `VOX_COMET_REALTIME_SCENARIO_NAME` и
   `VOX_COMET_REALTIME_RULE_NAME`.

5. На странице `Realtime-тест` выбрать «Гипотеза 2 · Comet + ElevenLabs» или «Гипотеза 2 · OpenAI напрямую + ElevenLabs». Голос берётся из выбранного плана прозвона, а параметры синтеза — из ElevenLabs Agent.

Конец реплики определяет backend по PCM-активности: после 350 мс тишины аудиобуфер коммитится в CometAPI. Новый ответ не запускается, пока Voximplant не подтвердит `MediaEventEnded` для предыдущей реплики.

Ключ CometAPI остаётся на backend. В `customData` Voximplant и браузер он не передаётся.
