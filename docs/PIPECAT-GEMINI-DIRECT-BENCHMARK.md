Прямой потоковый Gemini 3.8 Flash с Deepgram, 12 ноября 2026.

Последующая проверка других версий Gemini и рабочие Flash-Lite: [PIPECAT-GEMINI-OTHER-MODELS.md](PIPECAT-GEMINI-OTHER-MODELS.md).

Benchmark ID: `pcb-7ea0397a-b46b-400e-82c6-b9055d2d7ed2`. Выполнено по 5 попыток Nova-3 + Silero/Smart Turn и Flux Multilingual с собственным EOT. Одинаковая синтетическая запись из предыдущей серии (SHA256 совпадает), живой темп PCM16 mono 16 kHz, блоки 80 мс, короткий общий промпт. Gemini: прямой Google Developer API, `generate_content_stream`, thinking low. ProxyAPI, TTS, телефония и CRM не участвовали. Интервал между началами попыток — не менее 15 секунд.

Ключ прочитан из сохранённого корневого `.env`. Номер проекта для этого способа авторизации не передаётся. Две предварительные прямые проверки SDK закончились HTTP 503 с сообщением о высокой нагрузке модели. Основная серия выполнена полностью:

| Вариант | Попытки | Получены расшифровки | Успешные ответы Gemini | Ошибки Gemini |
| --- | ---: | ---: | ---: | --- |
| Nova-3 + Silero/Smart Turn + Gemini | 5 | 5 | 0 | 3 × HTTP 503, 2 × LLM completion timeout |
| Flux Multilingual + Gemini | 5 | 5 | 0 | 3 × HTTP 503, 2 × LLM completion timeout |

Медиану «конец речи → первый текст» и задержку Gemini посчитать нельзя: успешных образцов нет. Это не доказательство медленной генерации модели или ограничения Free Tier. Ответов 429/ошибок квоты в этой серии не наблюдалось; доступную квоту проекта успешным запросом подтвердить не удалось.

В завершённых STT-этапах этих неуспешных попыток медиана «конец речи → финальная расшифровка» составила 342,37 мс для Nova-3 и 1427,35 мс для Flux. Медианы границы реплики — 342,64 и 1427,98 мс соответственно. Эти промежуточные наблюдения не являются успешными замерами полной связки и не заменяют сравнение с Realtime. У Flux в финализацию входит определение конца реплики; Nova использует локальный Silero/Smart Turn.

Артефакты с правами 0600 в игнорируемом `storage/pipecat-benchmarks/`:

- `turns-gemini-direct-20261112.json`: исходные события, тексты STT, все 10 неуспешных попыток; успешные медианы null.
- `turns-gemini-direct-20261112.log`: журнал Pipecat с HTTP 503/тайм-аутами.
- `turns-gemini-direct-20261112-analysis.json`: причины по каждой попытке, предварительные проверки и отдельно помеченные промежуточные STT-медианы.

Причины восстановлены по сообщениям stderr, сопоставленным с завершением каждой попытки. Последующая версия скрипта также сохраняет тип исключения и HTTP-код непосредственно в pipeline_error, не сохраняя потенциально секретные сообщения SDK.

Повтор после восстановления доступности модели:

```sh
/tmp/salesboost-pipecat-locked/bin/python apps/pipecat-hypothesis/benchmark_turns.py \
  --gemini-provider gemini --variants nova3 flux --request-interval 15 \
  --input-wav storage/pipecat-benchmarks/input.wav --runs 5 \
  --output storage/pipecat-benchmarks/turns-gemini-direct-retry.json
```

Сервис гипотезы и production-пайплайн для этой серии не изменялись и не перезапускались.

Повторная проверка после замены ключа на ключ другого аккаунта: прямой streaming-запрос Gemini 3.8 Flash вернул HTTP 402 Payment Required, RESOURCE_EXHAUSTED. Сообщение Google: prepayment credits are depleted; требуется проверить проект и billing в AI Studio. Это другой ответ, чем прежние 503/тайм-ауты. Платный статус аккаунта не подтверждает наличие средств у проекта API-ключа. Новая серия из 10 запросов не запускалась из-за явного отказа по оплате. Результат без ключа: `storage/pipecat-benchmarks/gemini-replacement-key-preflight-20261112.json`, права 0600.
