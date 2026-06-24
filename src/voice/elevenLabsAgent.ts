import WebSocket from 'ws';
import { config } from '../config';

type AgentTurnResult = {
  clientMessage: string;
  audioBase64: string | null;
  audioMimeType: string | null;
  conversationId: string | null;
  userTranscript: string | null;
  endedByAgent: boolean;
};

type AgentConversation = {
  ws: WebSocket;
  ready: Promise<void>;
  conversationId: string | null;
  outputAudioFormat: string | null;
  waiters: Array<{
    resolve: (value: AgentTurnResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    idleTimeout: NodeJS.Timeout | null;
    audioChunks: string[];
    text: string;
    userTranscript: string;
    endedByAgent: boolean;
  }>;
};

const conversations = new Map<string, AgentConversation>();

export function isElevenLabsAgentEnabled(): boolean {
  return Boolean(config.elevenLabsApiKey && config.elevenLabsAgentId);
}

export function closeElevenLabsAgentConversation(sessionId: string): void {
  const conversation = conversations.get(sessionId);
  conversations.delete(sessionId);
  if (!conversation) return;
  try {
    conversation.ws.close();
  } catch {
    // best effort
  }
}

export function hasElevenLabsAgentConversation(sessionId: string): boolean {
  const conversation = conversations.get(sessionId);
  return Boolean(conversation && conversation.ws.readyState === WebSocket.OPEN);
}

async function getConversationUrl(): Promise<string> {
  if (!config.elevenLabsAgentId) throw new Error('ELEVENLABS_AGENT_ID is not configured');
  if (!config.elevenLabsApiKey) throw new Error('ELEVENLABS_API_KEY is not configured');

  const params = new URLSearchParams({
    agent_id: config.elevenLabsAgentId,
    include_conversation_id: 'true',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?${params.toString()}`, {
      headers: { 'xi-api-key': config.elevenLabsApiKey },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs signed URL error ${response.status}: ${body || response.statusText}`);
  }
  const data = await response.json() as { signed_url?: string };
  if (!data.signed_url) throw new Error('ElevenLabs did not return signed_url');
  return data.signed_url;
}

function wavFromPcm16Base64(chunks: string[], sampleRate = 16000): string | null {
  if (chunks.length === 0) return null;
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

function audioFromChunks(chunks: string[], format: string | null): { audioBase64: string | null; audioMimeType: string | null } {
  if (chunks.length === 0) return { audioBase64: null, audioMimeType: null };
  const normalized = String(format || '').toLowerCase();
  if (!normalized || normalized.includes('pcm')) {
    return { audioBase64: wavFromPcm16Base64(chunks, normalized.includes('8000') ? 8000 : 16000), audioMimeType: 'audio/wav' };
  }
  if (normalized.includes('mp3') || normalized.includes('mpeg')) {
    return { audioBase64: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64'))).toString('base64'), audioMimeType: 'audio/mpeg' };
  }
  if (normalized.includes('ulaw')) {
    return { audioBase64: null, audioMimeType: null };
  }
  return { audioBase64: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64'))).toString('base64'), audioMimeType: 'audio/wav' };
}

function completeNextWaiter(conversation: AgentConversation): void {
  const waiter = conversation.waiters.shift();
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  if (waiter.idleTimeout) clearTimeout(waiter.idleTimeout);
  const audio = audioFromChunks(waiter.audioChunks, conversation.outputAudioFormat);
  waiter.resolve({
    clientMessage: waiter.text.trim(),
    audioBase64: audio.audioBase64,
    audioMimeType: audio.audioMimeType,
    conversationId: conversation.conversationId,
    userTranscript: waiter.userTranscript.trim() || null,
    endedByAgent: waiter.endedByAgent,
  });
}

function scheduleIdleCompletion(conversation: AgentConversation, delayMs = 1600): void {
  const waiter = conversation.waiters[0];
  if (!waiter) return;
  if (waiter.idleTimeout) clearTimeout(waiter.idleTimeout);
  waiter.idleTimeout = setTimeout(() => {
    if (conversation.waiters[0] === waiter && (waiter.text.trim() || waiter.audioChunks.length > 0)) {
      completeNextWaiter(conversation);
    }
  }, delayMs);
}

function getClientToolCall(event: any): { id: string | null; name: string | null; parameters: unknown } | null {
  const call = event.client_tool_call || event.client_tool_call_event || event.tool_call || null;
  if (!call || typeof call !== 'object') return null;
  return {
    id: String(call.tool_call_id || call.id || call.call_id || '').trim() || null,
    name: String(call.tool_name || call.name || '').trim() || null,
    parameters: call.parameters ?? call.arguments ?? null,
  };
}

function sendClientToolResult(ws: WebSocket, toolCallId: string, result: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'client_tool_result',
    tool_call_id: toolCallId,
    result: typeof result === 'string' ? result : JSON.stringify(result),
    is_error: false,
  }));
}

function isConversationFinalEvent(type: string): boolean {
  return [
    'agent_response_complete',
    'conversation_ended',
    'conversation_end',
    'conversation_finished',
    'end_of_turn',
  ].includes(type);
}

async function getOrCreateConversation(
  sessionId: string,
  prompt: string | null | undefined,
  firstMessage: string | null,
  elevenLabsVoiceId?: string | null
): Promise<AgentConversation> {
  const existing = conversations.get(sessionId);
  if (existing && existing.ws.readyState === WebSocket.OPEN) return existing;
  if (existing) closeElevenLabsAgentConversation(sessionId);
  if (!prompt?.trim()) throw new Error('ElevenLabs prompt is required to start a new conversation');

  const ws = new WebSocket(await getConversationUrl());
  const conversation: AgentConversation = {
    ws,
    conversationId: null,
    outputAudioFormat: null,
    waiters: [],
    ready: Promise.resolve(),
  };
  conversation.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ElevenLabs connection timeout')), 8000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({
        type: 'conversation_initiation_client_data',
        conversation_config_override: {
          agent: {
            prompt: { prompt },
            first_message: firstMessage || undefined,
            language: 'ru',
          },
          tts: elevenLabsVoiceId?.trim()
            ? { voice_id: elevenLabsVoiceId.trim() }
            : undefined,
        },
      }));
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  ws.on('message', (raw) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (event.type === 'conversation_initiation_metadata') {
      const metadata = event.conversation_initiation_metadata_event || {};
      conversation.conversationId = metadata.conversation_id || conversation.conversationId;
      conversation.outputAudioFormat = metadata.agent_output_audio_format || conversation.outputAudioFormat;
      return;
    }
    if (event.type === 'ping' && event.ping_event?.event_id !== undefined) {
      ws.send(JSON.stringify({ type: 'pong', event_id: event.ping_event.event_id }));
      return;
    }
    const waiter = conversation.waiters[0];
    if (!waiter) return;
    if (event.type === 'agent_response') {
      waiter.text = String(event.agent_response_event?.agent_response || waiter.text || '');
      scheduleIdleCompletion(conversation);
      return;
    }
    if (event.type === 'user_transcript') {
      waiter.userTranscript = String(event.user_transcription_event?.user_transcript || waiter.userTranscript || '');
      return;
    }
    if (event.type === 'audio') {
      const chunk = event.audio_event?.audio_base_64;
      if (typeof chunk === 'string' && chunk) waiter.audioChunks.push(chunk);
      scheduleIdleCompletion(conversation);
      return;
    }
    if (event.type === 'client_tool_call') {
      const toolCall = getClientToolCall(event);
      if (toolCall?.id) {
        sendClientToolResult(ws, toolCall.id, {
          ok: true,
          handled_by: 'salesboost_trainer',
          tool_name: toolCall.name,
        });
      }
      if (toolCall?.name === 'end_call' || toolCall?.name === 'end_conversation') {
        waiter.endedByAgent = true;
        scheduleIdleCompletion(conversation, 250);
      }
      return;
    }
    if (isConversationFinalEvent(event.type)) {
      waiter.endedByAgent = waiter.endedByAgent || event.type !== 'agent_response_complete';
      completeNextWaiter(conversation);
    }
  });

  ws.on('close', () => {
    conversations.delete(sessionId);
    for (const waiter of conversation.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      if (waiter.idleTimeout) clearTimeout(waiter.idleTimeout);
      if (waiter.text.trim() || waiter.audioChunks.length > 0) {
        const audio = audioFromChunks(waiter.audioChunks, conversation.outputAudioFormat);
        waiter.resolve({
          clientMessage: waiter.text.trim(),
          audioBase64: audio.audioBase64,
          audioMimeType: audio.audioMimeType,
          conversationId: conversation.conversationId,
          userTranscript: waiter.userTranscript.trim() || null,
          endedByAgent: true,
        });
      } else {
        waiter.reject(new Error('ElevenLabs conversation closed'));
      }
    }
  });

  conversations.set(sessionId, conversation);
  try {
    await conversation.ready;
  } catch (error) {
    closeElevenLabsAgentConversation(sessionId);
    throw error;
  }
  return conversation;
}

export async function runElevenLabsAgentTurn(params: {
  sessionId: string;
  prompt?: string | null;
  managerText?: string;
  firstMessage?: string | null;
  elevenLabsVoiceId?: string | null;
}): Promise<AgentTurnResult> {
  const conversation = await getOrCreateConversation(
    params.sessionId,
    params.prompt,
    params.firstMessage ?? null,
    params.elevenLabsVoiceId
  );
  await conversation.ready;
  if (conversation.ws.readyState !== WebSocket.OPEN) {
    throw new Error('ElevenLabs conversation is not open');
  }

  const result = new Promise<AgentTurnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = conversation.waiters.findIndex((waiter) => waiter.reject === reject);
      if (index >= 0) {
        const waiter = conversation.waiters[index];
        if (waiter.idleTimeout) clearTimeout(waiter.idleTimeout);
        conversation.waiters.splice(index, 1);
      }
      reject(new Error('ElevenLabs agent response timeout'));
    }, 18000);
    conversation.waiters.push({ resolve, reject, timeout, idleTimeout: null, audioChunks: [], text: '', userTranscript: '', endedByAgent: false });
  });

  if (params.managerText?.trim()) {
    conversation.ws.send(JSON.stringify({ type: 'user_message', text: params.managerText.trim() }));
  }

  return result;
}

function splitBase64PcmChunks(audioBase64: string, chunkBytes = 3200): string[] {
  const audio = Buffer.from(audioBase64, 'base64');
  const chunks: string[] = [];
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    chunks.push(audio.subarray(offset, offset + chunkBytes).toString('base64'));
  }
  const trailingSilence = Buffer.alloc(chunkBytes * 6);
  chunks.push(trailingSilence.toString('base64'));
  return chunks;
}

export async function runElevenLabsAgentAudioTurn(params: {
  sessionId: string;
  prompt?: string | null;
  audioBase64: string;
  firstMessage?: string | null;
  elevenLabsVoiceId?: string | null;
}): Promise<AgentTurnResult> {
  const conversation = await getOrCreateConversation(
    params.sessionId,
    params.prompt,
    params.firstMessage ?? null,
    params.elevenLabsVoiceId
  );
  await conversation.ready;
  if (conversation.ws.readyState !== WebSocket.OPEN) {
    throw new Error('ElevenLabs conversation is not open');
  }

  const result = new Promise<AgentTurnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = conversation.waiters.findIndex((waiter) => waiter.reject === reject);
      if (index >= 0) {
        const waiter = conversation.waiters[index];
        if (waiter.idleTimeout) clearTimeout(waiter.idleTimeout);
        conversation.waiters.splice(index, 1);
      }
      reject(new Error('ElevenLabs agent audio response timeout'));
    }, 22000);
    conversation.waiters.push({ resolve, reject, timeout, idleTimeout: null, audioChunks: [], text: '', userTranscript: '', endedByAgent: false });
  });

  for (const chunk of splitBase64PcmChunks(params.audioBase64)) {
    conversation.ws.send(JSON.stringify({ user_audio_chunk: chunk }));
  }

  return result;
}
