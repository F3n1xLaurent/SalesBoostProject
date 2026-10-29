import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { naturalizeAssistantText, pcm16HasSpeech } from '../voice/yandexRealtimeTest';

const bridge = readFileSync(resolve(process.cwd(), 'src/voice/yandexRealtimeTest.ts'), 'utf8');
const scenario = readFileSync(resolve(process.cwd(), 'voximplant/scenario_voice_yandex_realtime_test.js'), 'utf8');
const callStarter = readFileSync(resolve(process.cwd(), 'src/voice/startVoiceCall.ts'), 'utf8');

describe('isolated Yandex Realtime hypothesis', () => {
  it('uses PCM16 for Yandex input and telephony-native mu-law for Vox output', () => {
    expect(scenario).toContain('WebSocketAudioEncoding.PCM16_16KHZ');
    expect(bridge).toContain("output_format=ulaw_8000");
    expect(bridge).toContain("format: { type: 'audio/pcm', rate: 16000 }");
    expect(bridge).toContain("mediaFormat: { encoding: 'ULAW' }");
    expect(bridge).toContain('this.timestamp += packet.length');
  });

  it('reuses the ElevenLabs Agent voice settings and records metrics per turn', () => {
    expect(bridge).toContain('/v1/convai/agents/');
    expect(bridge).toContain('fetchElevenLabs(');
    expect(bridge).toContain('elevenLabsWebSocketOptions()');
    expect(bridge).toContain('/v1/text-to-dialogue/multi-stream-input');
    expect(bridge).toContain('/v1/text-to-dialogue/stream-input');
    expect(bridge).toContain('class ElevenLabsV4DialogueSocket');
    expect(bridge).toContain('new ElevenLabsV4DialogueSocket(session)');
    expect(bridge).toContain('this.singleDialogueProtocol');
    expect(bridge).toContain('stopGenerationAndDrain()');
    expect(bridge).toContain('yandexRealtimeHandoffPauseMs');
    expect(bridge).toContain('formatElevenLabsError(message)');
    expect(bridge).toContain('tts.stability');
    expect(bridge).toContain('speechToTextMs');
    expect(bridge).toContain('ttsFirstAudioMs');
    expect(bridge).toContain('ttsGenerationMs');
    expect(bridge).toContain('audioDurationMs');
    expect(bridge).toContain('flush: true');
    expect(bridge).toContain('keep_alive: true');
    expect(bridge).toContain('close_context: true');
    expect(bridge).toContain('apply_text_normalization=on');
    expect(bridge).toContain('dialogueDeliveryDirective(text)');
    expect(bridge).toContain('HUMAN_CONVERSATION_INSTRUCTIONS');
    expect(bridge).toContain('effectiveAssistantContext(previousAssistantTurn)');
    expect(bridge).toContain('yandexRealtimeBargeInSustainedMs');
    expect(bridge).toContain('yandexRealtimeBargeInEnabled');
    expect(bridge).toContain("suppressNextResponseReason = 'assistant_turn_half_duplex'");
    expect(bridge).toContain("reason: 'assistant_turn_half_duplex'");
    expect(bridge).toContain('!config.yandexRealtimeBargeInEnabled && pendingMainOutput');
    expect(bridge).toContain('discardManagerAudioDuringAssistant(payload)');
    expect(bridge).toContain("type: 'manager_audio_discarded'");
    expect(bridge).toContain('speculative_response_started');
    expect(bridge).toContain('cancelSpeculativeOutput');
    expect(bridge).toContain('endpointResponseRequested');
    expect(bridge).toContain('strict_half_duplex_drain_timeout');
    expect(bridge).toContain('overlapping response suppressed before TTS');
    expect(bridge).toContain("classifyInterruption(currentSpeech.partialText");
    expect(bridge).toContain("type: 'barge_in_ignored'");
    expect(bridge).toContain('class VoxBackchannelPlayback');
    expect(bridge).toContain("playBackchannel('thinking', 'thinking_before_slow_response'");
    expect(bridge).toContain('scheduleThinkingBackchannel');
    expect(bridge).toContain("playBackchannel('listening', 'manager_still_speaking'");
    expect(bridge).toContain('yandexRealtimeListeningBackchannelEnabled');
    expect(bridge).toContain("backchannelPlaybackKind === 'thinking'");
    expect(bridge).toContain("const VERBAL_THINKING_FILLERS = ['Хм-м…', 'Так…']");
    expect(bridge).toContain("const LISTENING_BACKCHANNELS = ['Угу.', 'Ага.']");
    expect(bridge).toContain("'[clears throat]'");
    expect(bridge).not.toContain('seamlessHandoffTurn?.isPlaying() || responseActive || backchannelPlayback');
    expect(bridge).toContain('sourceLooksLikeQuestion(heardAtSpeechStart)');
    expect(bridge).toContain('ты AI-клиент и инициатор этого ИСХОДЯЩЕГО звонка');
    expect(bridge).toContain('Никогда не спрашивай сотрудника «по какому вопросу звонок?»');
    expect(bridge).toContain('finalizedContexts.has(contextId)');
    expect(bridge).toContain("type: 'endpoint_continuation_detected'");
    expect(bridge).toContain('pendingContinuationTranscriptIndex');
    expect(bridge).toContain('const packetBytes = 320');
    expect(bridge).toContain('FIRST_CHUNK_LOOKAHEAD = 40');
    expect(bridge).toContain('FIRST_CHUNK_MINIMUM = 28');
    expect(bridge).toContain('NEXT_CHUNK_LOOKAHEAD = 64');
    expect(bridge).toContain('Math.min(config.yandexRealtimeTurnGraceMs, 400)');
  });

  it('does not voice repetitive model acknowledgements as full replies', () => {
    expect(naturalizeAssistantText('Понял. Тогда когда можно приехать?')).toBe('Тогда когда можно приехать?');
    expect(naturalizeAssistantText('Понятно')).toBe('');
    expect(naturalizeAssistantText('Ясно, спасибо.')).toBe('спасибо.');
    expect(naturalizeAssistantText('Ага. Тогда когда можно приехать?')).toBe('Тогда когда можно приехать?');
    expect(naturalizeAssistantText('Хм...')).toBe('');
    expect(bridge).not.toContain("const BACKCHANNEL_TEXTS = ['Угу.', 'Ага.']");
  });

  it('distinguishes telephony silence from speech for strict half-duplex draining', () => {
    expect(pcm16HasSpeech(Buffer.alloc(320))).toBe(false);
    const speech = Buffer.alloc(320);
    for (let offset = 0; offset + 1 < speech.length; offset += 2) speech.writeInt16LE(2400, offset);
    expect(pcm16HasSpeech(speech)).toBe(true);
  });

  it('uses a dedicated webhook instead of the production call finalizer', () => {
    expect(callStarter).toContain('/webhooks/vox-yandex-realtime-test');
    expect(callStarter).toContain('/voice/yandex-realtime-test');
    expect(bridge).not.toContain('finalizeVoiceCallSession');
    expect(bridge).not.toContain('evaluateSession');
  });

  it('supports interruption and the required call controls', () => {
    expect(bridge).toContain("type: 'response.cancel'");
    expect(bridge).toContain("type: 'conversation.item.delete'");
    expect(bridge).toContain('sync_alignment=true');
    expect(bridge).toContain('playedAudioMs()');
    expect(bridge).toContain("action: 'clear_media'");
    expect(bridge).toContain("name: 'send_dtmf'");
    expect(bridge).toContain("name: 'end_call'");
    expect(bridge).toContain('requestHangupAfterFarewell');
    expect(bridge).toContain('deferred_until_audio_finished');
    expect(bridge).toContain('Спасибо, до свидания.');
    expect(bridge).toContain('The caller must first hear and identify the live employee');
    expect(scenario).toContain('call.sendDigits');
    expect(scenario).toContain('mediaSocket.clearMediaBuffer');
    expect(scenario).toContain('mediaSocket.sendMediaTo(call, { tag: "assistant" })');
    expect(scenario).not.toContain('WebSocketEvents.MESSAGE');
    expect(bridge).toContain("stop: { tag: 'assistant', mediaInfo: {} }");
  });
});
