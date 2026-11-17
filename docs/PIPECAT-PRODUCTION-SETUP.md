# Pipecat на production

`docker compose -f compose.prod.yaml up -d --build app` не включает отдельный Pipecat. Использовать оба compose-файла при первом запуске и дальнейших обновлениях:

```sh
docker compose -f compose.prod.yaml -f compose.pipecat.prod.yaml up -d --build app pipecat
```

Файлы объединяются средствами [Docker Compose](https://docs.docker.com/reference/compose-file/merge/). Команда подготовлена для запуска на сервере из корня актуального checkout; на удалённом production в рамках этой проверки не выполнялась.

## `.env`

Сгенерировать секрет на сервере: `openssl rand -hex 32`. Подставить результат и реальный домен:

```dotenv
CALL_PLAN_TELEPHONY_PROVIDER=pipecat
PIPECAT_HYPOTHESIS_URL=http://pipecat:8093
PIPECAT_HYPOTHESIS_PUBLIC_URL=https://sales.example.com/pipecat
PIPECAT_HYPOTHESIS_TOKEN=REPLACE_WITH_OPENSSL_RANDOM_TOKEN
PIPECAT_PRODUCTION_VOX_RULE=voice_pipecat_rule

PIPECAT_BACKGROUND_ENABLED=true
PIPECAT_BACKGROUND_VOLUME=0.2
PIPECAT_BREATH_EXPERIMENT=true
PIPECAT_BREATH_VOLUME=0.18

# Empty explicitly disables any inherited ElevenLabs proxy.
PIPECAT_ELEVENLABS_PROXY_URL=
```

Внутренний URL используется backend внутри Docker, публичный HTTPS/WSS — Voximplant для входящего аудио/событий и загрузки подписанных WAV. Внутренний URL и общий секрет для обоих контейнеров также задаются overlay; переменная секрета должна присутствовать в корневом `.env`. Порт 8093 наружу не публикуется.

Сохранить существующие рабочие ключи в том же `.env`: `OPENAI_API_KEY`, `PROXYAPI_API_KEY`, `ELEVENLABS_API_KEY`, `VOX_ACCOUNT_ID`, `VOX_API_KEY`, `VOX_APP_ID`, `VOX_CALLER_ID`. Первые три нужны текущему профилю: прямой Realtime/TTS и Decisions через ProxyAPI. Голоса в профилях должны быть доступны этому ElevenLabs-аккаунту; `ELEVENLABS_VOICE_ID` используется как запасной голос backend, если он требуется. Gemini/Deepgram для текущего профиля не нужны.

Профиль основных планов фиксирован кодом: `gpt-realtime-2.1`, `eleven_v4_turbo`, semantic, low, backchannel=true, trimIdleAudio=false. Существующие дефолты compose совпадают с локальными: `PIPECAT_SEMANTIC_MODEL=microsoft/microsoft-decision-1`, `PIPECAT_SPEECH_MODE=fast_sentence`, `PIPECAT_INTERRUPTION_MS=850`, `PIPECAT_MAX_CALL_SECONDS=900`, `PIPECAT_LINE_WAIT_SECONDS=180`, `PIPECAT_THINKING_DELAY_MS=1600`, `PIPECAT_THINKING_COOLDOWN_SECONDS=25`. В semantic-режиме фактический порог ожидающего звука не ниже 2400 мс. Если на проде уже переопределены эти значения, привести их к этим настройкам.

Если нужен прокси для ElevenLabs, указать доступный из контейнера адрес в `PIPECAT_ELEVENLABS_PROXY_URL`. Локальный `127.0.0.1` внутри контейнера относится к самому контейнеру, а не ноутбуку/хосту. Не переносить адрес локального туннеля с ноутбука без отдельной настройки.

## Файлы и ingress

- Аудиопак из `./call-background` включается в Git: добавить файлы в коммит и доставить их на сервер вместе с кодом. Дать контейнеру право чтения; папка смонтирована read-only. Файл вдоха входит в образ Pipecat через `audio/`.
- Применить в действующем Nginx блок `/pipecat/` из `nginx.prod.conf.example`: HTTP/WSS проксируются в backend, который проверяет токены и перенаправляет в приватный Pipecat. Проверить сертификат публичного домена. Для живой истории планов также перенести новый блок `/api/admin/call-settings/plans/.../calls/live`.
- Если на проде другой аккаунт/application Voximplant, загрузить актуальный `voice_pipecat` и связать правило `voice_pipecat_rule` в этом application. При той же учётной записи и приложении уже развёрнутый сценарий можно использовать; его URL задаются для каждого звонка.
- Сохранять volumes `pipecat_logs` и `salesboost_voice_pipecat` вместе с уже существующими volumes базы/записей. Новая приватная папка состояния подготовлена в Dockerfile для UID node; Python-логи имеют отдельный volume.

## Проверка после выкладки

```sh
docker compose -f compose.prod.yaml -f compose.pipecat.prod.yaml ps
curl -fsS https://sales.example.com/health
curl -fsS https://sales.example.com/pipecat/health
```

Оба контейнера должны быть healthy; `/health` — provider=pipecat, `/pipecat/health` — `{"ok":true}`. После этого выполнить один контрольный звонок и проверить аудио, запись, завершение и появление отчёта перед запуском аудитории.

Локально проверено объединение compose: два сервиса, совпадающий общий токен, app→pipecat по имени сервиса, ожидание healthcheck, отсутствие опубликованного порта Pipecat, дополнительный постоянный volume. Полный production build и Nginx на удалённом сервере не запускались.
