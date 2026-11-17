# Pipecat hypothesis

Semantic-17: [отключаемый эксперимент с тихим вдохом через отдельный плеер Voximplant](../../docs/PIPECAT-BREATH-EXPERIMENT.md).

Semantic-16: [защита вступления от ложного перебивания, подтверждения и передача бэквойса ответу](../../docs/PIPECAT-CALL-53030805.md).

Semantic-15: [зависания при согласовании визита, callback и лишняя генерация](../../docs/PIPECAT-CALL-81960b7c.md).

Semantic-14: [повторы, реакции слушания и стиль плана](../../docs/PIPECAT-CALL-2141ac4c.md).

Защита линии semantic-13: [IVR, DTMF, автоответчик и перевод между сотрудниками](../../docs/PIPECAT-LINE-GATE.md). [Восстановление начала разговора и непрерывный фон](../../docs/PIPECAT-CALL-bd989d6f.md).

Подключение к основным звонкам по таймеру и аудитории, очередь, запись, оценка и откат: [PIPECAT-CALL-PLAN-INTEGRATION.md](../../docs/PIPECAT-CALL-PLAN-INTEGRATION.md).

Сохранение согласованного визита, перенос после отказа и ограничение повторных «Секунду»: [PIPECAT-CALL-9dd52fe3-9361a976.md](../../docs/PIPECAT-CALL-9dd52fe3-9361a976.md).

Выбор времени приезда, ошибочное имя и развивающаяся легенда клиента: [PIPECAT-CALL-2100917b.md](../../docs/PIPECAT-CALL-2100917b.md).

Восстановление вопроса после перебивания и последующего обсуждения визита: [PIPECAT-CALL-a57c4598.md](../../docs/PIPECAT-CALL-a57c4598.md).

Восстановление после единичного таймаута распознавания: [PIPECAT-CALL-d7f47aec.md](../../docs/PIPECAT-CALL-d7f47aec.md).

Запрос значения имени, его подтверждение и составное аудиоприветствие: [PIPECAT-CALL-29bbe944.md](../../docs/PIPECAT-CALL-29bbe944.md).

Общий фильтр основных реплик, подтверждение имени и уточнения времени: [PIPECAT-CALL-caef5dfb.md](../../docs/PIPECAT-CALL-caef5dfb.md).

Встречные вопросы и защита от повторного прощания: [PIPECAT-CALL-bbf7ade1.md](../../docs/PIPECAT-CALL-bbf7ade1.md).

Нейтральные и более редкие вставки ожидания: [PIPECAT-CALL-878c58d5.md](../../docs/PIPECAT-CALL-878c58d5.md).

Паузы от конца речи, бэквойсы и принятие первого подтверждения встречи: [PIPECAT-CALL-68334c34.md](../../docs/PIPECAT-CALL-68334c34.md).

Один вопрос на ход, устранение лишних свободных генераций, анализ задержек: [PIPECAT-CALL-79f3a9f6.md](../../docs/PIPECAT-CALL-79f3a9f6.md).

Отдельный режим «Смысловой контроллер · эксперимент», активация и проверки: [PIPECAT-SEMANTIC-1.md](../../docs/PIPECAT-SEMANTIC-1.md).

Запросы имени и согласие на встречу без повторного уточнения времени: [PIPECAT-CALL-545ef7e1.md](../../docs/PIPECAT-CALL-545ef7e1.md).

Фоновый аудиопак: кладите файлы в [call-background/](../../call-background/README.md). Цепочка загрузки, loop, громкость и проверки: [PIPECAT-BACKGROUND-AUDIO.md](../../docs/PIPECAT-BACKGROUND-AUDIO.md).

Завершение подтверждённого визита при заданных вопросах без ответа: [PIPECAT-CALL-0452e7be.md](../../docs/PIPECAT-CALL-0452e7be.md).

Контекстные голосовые вставки при долгой генерации, порог и проверки: [PIPECAT-CALL-6d173229.md](../../docs/PIPECAT-CALL-6d173229.md).

Python-сервис обслуживает рабочие звонки по плану через приватный двухфазный API и отдельный эксперимент гипотезы 3 в `/testing`. Их запуск и история разделены.

Для локального Docker из корня репозитория:

```sh
npm run pipecat:up
npm run pipecat:status
npm run pipecat:logs
```

Backend остаётся на хосте и обращается к `http://127.0.0.1:8093`. Команда запуска автоматически добавляет URL и общий токен в корневой `.env`; после первого запуска backend должен перечитать `.env`. Контейнер перезапускается Docker автоматически, логи метрик хранятся в отдельном volume. `npm run pipecat:down` останавливает только Pipecat и сохраняет volume.

Gemini через ProxyAPI использует существующий `PROXYAPI_API_KEY` из корневого `.env`. В `/testing` выберите «Gemini 3.8 Flash · ProxyAPI». Полная проба без звонка:

```sh
docker compose -f compose.pipecat.yaml exec -T pipecat python probe_gemini.py --output /data/logs/gemini-proxyapi-probe.json
```

Инструкции, проверенная совместимость, формат аудио, сценарии сравнения и ограничения: [docs/PIPECAT-HYPOTHESIS.md](../../docs/PIPECAT-HYPOTHESIS.md).

```sh
uv sync --locked
uv run --locked python -m unittest discover -v
uv run --locked uvicorn service:app --host 127.0.0.1 --port 8093 --no-access-log
```

Исправления очередей Realtime, поздней STT и завершения визита, а также синтетические пробы обеих моделей: [PIPECAT-TURN-FIXES.md](../../docs/PIPECAT-TURN-FIXES.md).

Последняя итерация Mini: фиксация визита с вопросом, короткий формат реплик, метрики выпуска текста/отправки TTS и сравнение low/minimal: [PIPECAT-MINI-DIALOGUE-2.md](../../docs/PIPECAT-MINI-DIALOGUE-2.md).

Оптимизации conversation-3: бюджет инструментов, ускоренная передача целых предложений TTS, сравнение промптов и порогов перебивания, сетевые метрики: [PIPECAT-CONVERSATION-3.md](../../docs/PIPECAT-CONVERSATION-3.md).

Отдельное сравнение фиксированного промпта и локального Dialogue State Manager на демонстрационном плане, по пять проходов: [PIPECAT-DIALOGUE-STATE-BENCHMARK.md](../../docs/PIPECAT-DIALOGUE-STATE-BENCHMARK.md).

Предварительно подготовленные вопросы: реальная Mini + TTS против готового текста и PCM, по пять повторов с попаданиями и fallback: [PIPECAT-PREPARED-REPLIES-BENCHMARK.md](../../docs/PIPECAT-PREPARED-REPLIES-BENCHMARK.md).

Параллельная предгенерация новой реплики Mini и озвучки с настоящим Decisions через ProxyAPI, по пять парных проходов: [PIPECAT-SPECULATIVE-DECISIONS-BENCHMARK.md](../../docs/PIPECAT-SPECULATIVE-DECISIONS-BENCHMARK.md).

Текущая версия conversation-4: обработка пустой STT, разговорное время, закрытые темы и представление с подтверждением воспроизведения: [PIPECAT-CONVERSATION-4.md](../../docs/PIPECAT-CONVERSATION-4.md).

Отдельный режим controller-1: готовые озвученные вопросы, управление ходами и экспериментальный backchannel: [PIPECAT-CONTROLLER-1.md](../../docs/PIPECAT-CONTROLLER-1.md).

Controller-2: закрытие реальной аудиоочереди, исправление дублей вопросов, составное предложение визита и завершение на прощание: [PIPECAT-CONTROLLER-2.md](../../docs/PIPECAT-CONTROLLER-2.md).

Controller-3: отдельные формулировки и озвучка для каждого запуска до набора номера, сохранение раннего визита с продолжением обязательных тем: [PIPECAT-CALL-65ab0b38.md](../../docs/PIPECAT-CALL-65ab0b38.md).

Controller-10: контекст до первого аудио, буфер ранней речи, ограниченный таймаут старта и проверка полного аудиопайплайна: [PIPECAT-CALL-687a41d2.md](../../docs/PIPECAT-CALL-687a41d2.md).

Controller-9: выбор предложенного окна визита, контекстное подтверждение, прощание после playback ACK и подготовленные разговорные переходы: [PIPECAT-CALL-362bf7a4.md](../../docs/PIPECAT-CALL-362bf7a4.md).

Controller-8: новые native-вопросы проходят смысловую проверку до TTS и регистрируются в общем реестре; дубли сохраняют прежние ID: [PIPECAT-NATIVE-QUESTION-GATE.md](../../docs/PIPECAT-NATIVE-QUESTION-GATE.md).

Controller-7: жёсткий запрет повторной отправки вопроса по ID, защита конкурентных путей и запрет native-вопросов перед TTS: [PIPECAT-CALL-deda1dc6.md](../../docs/PIPECAT-CALL-deda1dc6.md).

Controller-6: ответ с приглашением не теряется, отменённое предложение времени не расходует попытку, генерационные «Так…» отключены, лимит сценария настраивается: [PIPECAT-CALL-13fa3ea6.md](../../docs/PIPECAT-CALL-13fa3ea6.md).

Controller-5: сборка поздних ASR-фрагментов, независимое сохранение ответа и обработка встречного вопроса, восстановление вступления и повтор аудио при проблеме связи: [PIPECAT-CALL-5b749f6d.md](../../docs/PIPECAT-CALL-5b749f6d.md).

Controller-4: составные вопросы, скидка с обсуждением на месте, подтверждение времени без циклов и отмена backchannel без сброса основного TTS: [PIPECAT-CALL-3e41a91d.md](../../docs/PIPECAT-CALL-3e41a91d.md).
