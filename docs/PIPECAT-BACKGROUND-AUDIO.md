# Постоянный фон звонка Pipecat

Папка в корне: `call-background/`. Один случайный файл из WAV/MP3/OGG/FLAC/M4A/AAC/OPUS выбирается на каждый звонок. При пустой папке фон отключён. Файлы подключены к контейнеру через read-only bind mount, новые файлы доступны без перезапуска. Аудиопак игнорируется Git.

Цепочка: файл на хосте → `background_audio.py` → кэш WAV PCM16/mono/16 кГц с gain 0.2 → подписанный HTTPS `/pipecat/background/<sha256>.wav?token=...` → `script_custom_data.background_audio` → `VoxEngine.createURLPlayer({url}, {loop:true,onPause:true})` → Conference → звонок. Речь WebSocket поступает в ту же Conference. Входящий звук менеджера отправляется напрямую в WebSocket.

В VoxEngine новый входящий поток заменяет предыдущий; два `sendMediaTo(call)` не дают смешивания. Поэтому используется `Modules.Conference` и стандартная конференция `hd_audio:false` (8 кГц) для PSTN. Подтверждение: [официальные typings VoxEngine](https://cdn.voximplant.com/voxengine_typings/voxengine.d.ts), `createURLPlayer`, `URLPlayerParameters`, `ConferenceParameters`, `createConference`. Громкость применяется в самом WAV: неподтверждённого параметра `volume` в URLPlayer нет. Gain 0.2 означает 20% амплитуды исходной записи, а не нормализацию воспринимаемой громкости разных файлов.

Плеер загружает файл во время дозвона и возобновляется по `CallEvents.Connected`. Встроенный `loop:true` повторяет файл. При неожиданном `PlaybackFinished` создаётся новый плеер; сетевые ошибки допускают два повторных запуска и затем отключают только фон. Ошибка файла не прерывает основной звонок. При завершении останавливаются плеер, таймер повтора и конференция.

`clear_media` очищает только буфер речи WebSocket. Фон не имеет speech tags, не попадает в STT/VAD и не участвует в `Playback.can_hangup`. События проигрывания речи продолжают приходить от WebSocket, а не от непрерывного смешанного потока. Наличие фона не продлевает звонок после прощания.

Кэш адресуется хешем содержимого + формата + громкости; URL стабилен для повторных звонков и совместим с кэшированием URLPlayer. Произвольные пути и симлинки вне папки не обслуживаются, служебный Bearer-токен в URL не передаётся: используется отдельная HMAC-подпись конкретного WAV. GET/HEAD/Range поддерживаются Python-сервисом и ограниченным backend gateway.

Настройки корневого `.env`:

```dotenv
PIPECAT_BACKGROUND_ENABLED=true
PIPECAT_BACKGROUND_VOLUME=0.2
```

Применение настроек: `npm run pipecat:up`. Файлы не требуют этой команды. Исходник до 100 МиБ, подготовленный WAV строго меньше 10 МБ. Конвертация ограничена 30 секундами; повреждённый файл пропускается с диагностикой, пробуются до трёх кандидатов. ffmpeg установлен в контейнере.

В отчёте звонка: `background_selected` (имя файла, хеш, громкость), `background_prepare_failed`, `background_not_configured`, `background_playback` (`background_started`, `background_failed`, `background_restarted`, `background_stopped`). Фон не изменяет lifecycle-статус звонка.

Проверки:

- 274 Python-теста в Docker, включая настоящую конвертацию и проверку образцов PCM 10000 → 2000; все прошли. Локально один тест реальной конвертации пропускается, если ffmpeg не установлен.
- 11 тестов границ публичного gateway; 5 VM-тестов VoxEngine: пауза до соединения, смешивание, сохранение фона при перебивании, speech ACK, повтор, ограничение ошибок, очистка при отключении и отсутствие фона.
- `npx tsc --noEmit` прошёл.
- `node scripts/check-pipecat-background.mjs`: настоящий Docker ffmpeg → private HTTP → публичный HTTPS, идентичные 32078 байт WAV, амплитуда 0.2, HEAD и Range, неверная подпись отклонена. Используется временный синтетический тон, пользовательская папка не изменяется, телефонные вызовы не выполняются.

Сценарий развёрнут только в `voice_pipecat_hypothesis` / `voice_pipecat_hypothesis_rule`. Предыдущее тело сохранено штатным deploy-скриптом. Production voice pipeline не менялся. Реальный звонок с пользовательским аудиопаком ещё нужен для субъективной оценки громкости и стыка петли.
