import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const provider = process.env.REALTIME_CHECK_PROVIDER?.trim().toLowerCase() === 'openai' ? 'openai' : 'comet';
const apiKey = (provider === 'openai'
  ? process.env.OPENAI_REALTIME_API_KEY
  : process.env.COMETAPI_API_KEY)?.trim();
const model = (provider === 'openai'
  ? process.env.OPENAI_REALTIME_MODEL
  : process.env.COMETAPI_REALTIME_MODEL)?.trim() || 'gpt-realtime-2';
const baseUrl = (provider === 'openai'
  ? process.env.OPENAI_REALTIME_URL
  : process.env.COMETAPI_REALTIME_URL)?.trim()
  || (provider === 'openai' ? 'wss://api.openai.com/v1/realtime' : 'wss://api.cometapi.com/v1/realtime');
const protocol = process.env.COMETAPI_REALTIME_PROTOCOL?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'ga';
const productionShape = process.env.COMETAPI_REALTIME_CHECK_PRODUCTION?.trim() === '1';

if (!apiKey) {
  console.error(`${provider === 'openai' ? 'OPENAI_REALTIME_API_KEY' : 'COMETAPI_API_KEY'} is not configured.`);
  process.exit(1);
}

const url = new URL(baseUrl);
url.searchParams.set('model', model);
const startedAt = performance.now();
let socketOpenedAt: number | null = null;
let sessionCreatedAt: number | null = null;
let sessionUpdatedAt: number | null = null;
let responseRequestedAt: number | null = null;
let responseCreatedAt: number | null = null;
let firstTextAt: number | null = null;
let sessionUpdateSent = false;
let requestSent = false;
let completed = false;

function sendSessionUpdate(socket: WebSocket): void {
  if (sessionUpdateSent || socket.readyState !== WebSocket.OPEN) return;
  sessionUpdateSent = true;
  socket.send(JSON.stringify({
    type: 'session.update',
    session: protocol === 'legacy'
      ? {
          modalities: ['text'],
          instructions: 'Отвечай одним коротким русским предложением.',
        }
      : {
          type: 'realtime',
          output_modalities: ['text'],
          instructions: 'Отвечай одним коротким русским предложением.',
          ...(productionShape ? {
            max_output_tokens: 300,
            reasoning: { effort: 'low' },
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: provider === 'openai'
                    ? (process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-transcribe')
                    : (process.env.COMETAPI_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-transcribe'),
                  language: 'ru',
                },
                turn_detection: null,
              },
            },
            tools: [{
              type: 'function',
              name: 'send_dtmf',
              description: 'Нажать одну кнопку телефонного IVR.',
              parameters: {
                type: 'object',
                properties: { digit: { type: 'string', enum: ['0','1','2','3','4','5','6','7','8','9','*','#'] } },
                required: ['digit'],
              },
            }, {
              type: 'function',
              name: 'skip_turn',
              description: 'Молча продолжить слушать линию.',
              parameters: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['ivr', 'waiting', 'background_noise', 'uncertain'] },
                  reason: { type: 'string' },
                },
                required: ['kind'],
              },
            }, {
              type: 'function',
              name: 'end_call',
              description: 'Завершить звонок.',
              parameters: {
                type: 'object',
                properties: { reason: { type: 'string' } },
                required: ['reason'],
              },
            }],
            tool_choice: 'auto',
          } : {}),
        },
  }));
}

function sendTestRequest(socket: WebSocket): void {
  if (requestSent || socket.readyState !== WebSocket.OPEN) return;
  requestSent = true;
  socket.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Ответь: соединение работает.' }],
    },
  }));
  responseRequestedAt = performance.now();
  socket.send(JSON.stringify({ type: 'response.create' }));
}

function elapsed(from: number, to = performance.now()): number {
  return Math.round((to - from) * 10) / 10;
}

function printMetrics(doneAt: number): void {
  const metrics = {
    websocketOpenMs: socketOpenedAt == null ? null : elapsed(startedAt, socketOpenedAt),
    sessionCreatedMs: sessionCreatedAt == null ? null : elapsed(startedAt, sessionCreatedAt),
    sessionUpdatedMs: sessionUpdatedAt == null ? null : elapsed(startedAt, sessionUpdatedAt),
    requestToResponseCreatedMs:
      responseRequestedAt == null || responseCreatedAt == null
        ? null
        : elapsed(responseRequestedAt, responseCreatedAt),
    requestToFirstTextMs:
      responseRequestedAt == null || firstTextAt == null
        ? null
        : elapsed(responseRequestedAt, firstTextAt),
    requestToDoneMs:
      responseRequestedAt == null ? null : elapsed(responseRequestedAt, doneAt),
    totalMs: elapsed(startedAt, doneAt),
  };

  console.log('\nLatency metrics:');
  console.log(`  WebSocket open:            ${metrics.websocketOpenMs ?? '—'} ms`);
  console.log(`  Session created:           ${metrics.sessionCreatedMs ?? '—'} ms`);
  console.log(`  Session ready:             ${metrics.sessionUpdatedMs ?? '—'} ms`);
  console.log(`  Request -> response start: ${metrics.requestToResponseCreatedMs ?? '—'} ms`);
  console.log(`  Request -> first text:     ${metrics.requestToFirstTextMs ?? '—'} ms`);
  console.log(`  Request -> response done:  ${metrics.requestToDoneMs ?? '—'} ms`);
  console.log(`  Total:                     ${metrics.totalMs} ms`);
  console.log(`METRICS_JSON ${JSON.stringify(metrics)}`);
}

const socketHeaders: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
const betaHeader = process.env.COMETAPI_REALTIME_BETA_HEADER?.trim();
if ((provider === 'comet' && betaHeader !== '0') || (provider === 'openai' && betaHeader === '1')) {
  socketHeaders['OpenAI-Beta'] = 'realtime=v1';
}
const socket = new WebSocket(url, { headers: socketHeaders });

const timeout = setTimeout(() => {
    console.error(`${provider === 'openai' ? 'OpenAI' : 'CometAPI'} Realtime check timed out.`);
  socket.close();
  process.exitCode = 1;
}, 20_000);

socket.on('open', () => {
  socketOpenedAt = performance.now();
  console.log(`WebSocket connected: ${model}, protocol=${protocol} (${elapsed(startedAt, socketOpenedAt)} ms)`);
  // Older CometAPI examples send session.update immediately after the
  // gateway socket opens instead of waiting for session.created.
  if (protocol === 'legacy') sendSessionUpdate(socket);
});
socket.on('message', (raw) => {
  let event: any;
  try { event = JSON.parse(raw.toString()); } catch { return; }
  if (event.type === 'session.created') {
    sessionCreatedAt = performance.now();
    sendSessionUpdate(socket);
    return;
  }
  if (event.type === 'session.updated') {
    sessionUpdatedAt = performance.now();
    sendTestRequest(socket);
    return;
  }
  if (event.type === 'response.created') {
    responseCreatedAt = performance.now();
    return;
  }
  if (event.type === 'response.text.delta' || event.type === 'response.output_text.delta') {
    firstTextAt ??= performance.now();
    process.stdout.write(String(event.delta ?? ''));
    return;
  }
  if (event.type === 'response.done') {
    const doneAt = performance.now();
    completed = true;
    process.stdout.write(`\n${provider === 'openai' ? 'OpenAI' : 'CometAPI'} Realtime is ready.\n`);
    printMetrics(doneAt);
    clearTimeout(timeout);
    socket.terminate();
    return;
  }
  if (event.type === 'error') {
    clearTimeout(timeout);
    console.error(`${provider === 'openai' ? 'OpenAI' : 'CometAPI'} error: ${String(event.error?.message ?? event.error ?? 'unknown')}`);
    socket.close();
    process.exitCode = 1;
  }
});
socket.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`WebSocket error: ${error.message}`);
  process.exitCode = 1;
});
socket.on('close', (code, reason) => {
  clearTimeout(timeout);
  if (!completed) {
    console.error(`WebSocket closed: code=${code}, reason=${reason.toString() || '—'}, after=${elapsed(startedAt)} ms`);
    if (code !== 1000) process.exitCode = 1;
  }
});

