import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  areRussianNamesEquivalent,
  classifyHypothesis2LineLocally,
  extractAssistantPreferredName,
  extractManagerAddressedClientName,
  extractManagerPreferredName,
  hasExplicitHoldInstruction,
  hasNaturalFarewell,
  looksLikeManagerQuestion,
  isGarbledManagerText,
  resamplePcm16Base64To24Khz,
  sanitizeRealtimeSpokenText,
} from '../voice/cometRealtimeTest';

const bridge = readFileSync(resolve(process.cwd(), 'src/voice/cometRealtimeTest.ts'), 'utf8');
const scenario = readFileSync(resolve(process.cwd(), 'voximplant/scenario_voice_comet_realtime_test.js'), 'utf8');

describe('Comet Realtime PCM bridge', () => {
  it('resamples a 16 kHz PCM frame to the exact 24 kHz duration', () => {
    const input = Buffer.alloc(320 * 2);
    for (let index = 0; index < 320; index += 1) {
      input.writeInt16LE(Math.round(Math.sin(index / 12) * 12_000), index * 2);
    }

    const output = Buffer.from(resamplePcm16Base64To24Khz(input.toString('base64')), 'base64');

    expect(output.length / 2).toBe(480);
    expect(output.readInt16LE(0)).toBe(input.readInt16LE(0));
  });

  it('does not forward an empty media frame', () => {
    expect(resamplePcm16Base64To24Khz('')).toBe('');
  });

  it('never sends technical completion instructions to TTS', () => {
    expect(sanitizeRealtimeSpokenText('Спасибо, до свидания. Краткое завершение разговора.'))
      .toBe('Спасибо, до свидания.');
    expect(sanitizeRealtimeSpokenText('Вызови функцию end_call.')).toBe('');
    expect(sanitizeRealtimeSpokenText('Я хотел бы завершить разговор. До свидания.'))
      .toBe('До свидания.');
    expect(sanitizeRealtimeSpokenText('Тогда я хочу завершить разговор. Всего доброго.'))
      .toBe('Всего доброго.');
    expect(sanitizeRealtimeSpokenText('Хорошо, тогда я быстро подытожу для себя и решу, как лучше поступить дальше.'))
      .toBe('');
    expect(sanitizeRealtimeSpokenText('Супер, тогда я коротко завершу разговор и зафиксирую, что мы договорились.'))
      .toBe('');
    expect(sanitizeRealtimeSpokenText('Хорошо, тогда сейчас коротко договоримся и я поеду.'))
      .toBe('');
    expect(sanitizeRealtimeSpokenText('Сейчас быстро уточню это по делу, чтобы дальше было понятно, как смотреть машину.')).toBe('');
    expect(sanitizeRealtimeSpokenText('Сейчас коротко уточню один момент и дальше уже поедем к визиту.')).toBe('');
    expect(sanitizeRealtimeSpokenText('Тогда уточню: какой пробег?')).toBe('Тогда уточню: какой пробег?');
  });

  it('detects an explicitly corrected manager name', () => {
    expect(extractManagerPreferredName('Меня зовут Антон, не Андрей.')).toBe('Антон');
    expect(extractManagerPreferredName('Зовите меня Никита.')).toBe('Никита');
    expect(extractManagerPreferredName('Не Олег, а Игорь.')).toBe('Игорь');
    expect(extractManagerPreferredName('Теперь я Сергей.')).toBe('Сергей');
    expect(extractManagerPreferredName('Давайте я буду Максим.')).toBe('Максим');
    expect(extractManagerPreferredName('Меня зовут не Никита, а Антон.')).toBe('Антон');
  });

  it.each([
    'Зафиксирую договорённость и закроем разговор.',
    'Тогда зафиксируем нашу договоренность.',
    'Хорошо, закрываем этот звонок.',
    'Сейчас зафиксирую, что мы договорились.',
    'Перехожу к завершению.',
    'Оформлю завершение разговора.',
  ])('blocks a narrated closing intention: %s', (text) => {
    expect(sanitizeRealtimeSpokenText(text)).toBe('');
    expect(sanitizeRealtimeSpokenText(`${text} Спасибо, до свидания.`)).toBe('Спасибо, до свидания.');
  });

  it('retains the farewell from a sentence containing a technical intention', () => {
    expect(sanitizeRealtimeSpokenText('Зафиксирую договорённость и закроем разговор, до свидания.')).toBe('до свидания.');
  });

  it('preserves real agreements and stops after the first goodbye', () => {
    expect(sanitizeRealtimeSpokenText('Договорились, завтра к пяти. Спасибо, до свидания. Всего доброго.')).toBe('Договорились, завтра к пяти. Спасибо, до свидания.');
    expect(sanitizeRealtimeSpokenText('Запишу адрес. До встречи завтра к пяти.')).toBe('Запишу адрес. До встречи завтра к пяти.');
    expect(sanitizeRealtimeSpokenText('Спасибо, до свидания, всего доброго.')).toBe('Спасибо, до свидания.');
    expect(hasNaturalFarewell('Пока не определилась со способом оплаты.')).toBe(false);
  });

  it('detects when the manager addresses the AI client by a wrong name', () => {
    expect(extractAssistantPreferredName('Здравствуйте. Меня зовут Дмитрий, звоню по объявлению.')).toBe('Дмитрий');
    expect(extractAssistantPreferredName('Здравствуйте. Я Анна, звоню по машине.')).toBe('Анна');
    expect(extractAssistantPreferredName('Я понял.')).toBeNull();
    expect(extractManagerAddressedClientName('Нет, Алексей, никаких проблем нет.')).toBe('Алексей');
    expect(extractManagerAddressedClientName('Слушайте, Вань, можем скинуть пять процентов.')).toBe('Вань');
    expect(areRussianNamesEquivalent('Дмитрий', 'Дима')).toBe(true);
    expect(areRussianNamesEquivalent('Дмитрий', 'Алексей')).toBe(false);
  });

  it('recognizes Russian farewells and unanswered questions without ASCII word boundaries', () => {
    expect(hasNaturalFarewell('Спасибо за информацию. До свидания.')).toBe(true);
    expect(hasNaturalFarewell('Хорошо, тогда посмотрю варианты.')).toBe(false);
    expect(hasNaturalFarewell('Спасибо.')).toBe(false);
    expect(looksLikeManagerQuestion('Какой автомобиль сейчас эксплуатируете')).toBe(true);
    expect(looksLikeManagerQuestion('Вы тогда сможете приехать?')).toBe(true);
    expect(looksLikeManagerQuestion('Хорошо, договорились.')).toBe(false);
  });

  it('does not let skip_turn mute an ordinary live-manager question', () => {
    expect(hasExplicitHoldInstruction('Какой автомобиль сейчас эксплуатируете?')).toBe(false);
    expect(hasExplicitHoldInstruction('Подождите минуту, сейчас уточню информацию.')).toBe(true);
    expect(hasExplicitHoldInstruction('Оставайтесь на линии, я вас переключу.')).toBe(true);
    expect(hasExplicitHoldInstruction('Подождите, пожалуйста. У меня другой вопрос, я хотел уточнить комплектацию.')).toBe(false);
    expect(hasExplicitHoldInstruction('Сейчас переведу на другого сотрудника. Оставайтесь на линии.')).toBe(true);
  });

  it('reopens the output for a live employee after a completed transfer', () => {
    expect(classifyHypothesis2LineLocally('Алло, отдел продаж, меня зовут Сергей, коллега передал ваш звонок. Чем могу помочь?')?.speakerType).toBe('live_human');
    expect(classifyHypothesis2LineLocally('Ваш звонок очень важен для нас. Ожидайте ответа оператора.')?.speakerType).toBe('ivr_or_recording');
    expect(isGarbledManagerText('который было не в любое время.')).toBe(true);
    expect(isGarbledManagerText('Приезжайте в любое время.')).toBe(false);
  });

  it('uses the call-plan ElevenLabs voice and lets Voximplant only transport audio', () => {
    expect(bridge).toContain('plan.elevenLabsVoiceId || elevenLabsTts.defaultVoiceId');
    expect(bridge).toContain('resolveAgentTtsSettings()');
    expect(bridge).toContain('output_format=ulaw_8000');
    expect(bridge).toContain("mediaFormat: { encoding: 'ULAW' }");
    expect(scenario).toContain('mediaSocket.sendMediaTo(call, { tag: "assistant" })');
    expect(scenario).not.toContain('createTTSPlayer');
    expect(scenario).not.toContain('VoiceList.');
  });

  it('keeps ElevenLabs warm and uses a local speed-first endpoint without duplicate opening responses', () => {
    expect(bridge).toContain('class CometElevenLabsV4Socket');
    expect(bridge).toContain('dialogueSocket?.connect()');
    expect(bridge).toContain('prepareRealtimeProviders(session)');
    expect(bridge).not.toContain("purpose: 'startup_warmup'");
    expect(bridge).toContain('silentResponseRetryCount');
    expect(bridge).toContain('response.instructions replaces the session instructions');
    expect(bridge).toContain('`${sessionInstructions(session)}\\n\\n${extra}`');
    expect(bridge).toContain('Repeating it in the first response.create');
    expect(bridge).toContain('Не оставляй ответ пустым');
    expect(bridge).toContain('preparedSpeechSockets.set(session.callId, prepared)');
    expect(bridge).toContain('cachedPreparedComet?.isUsable()');
    expect(bridge).toContain('providerReconnectCount >= 2');
    expect(bridge).toContain('переподключение до готовности сессии');
    expect(bridge).toContain('await prepared.waitUntilReady(5_000)');
    expect(bridge).toContain('Звонок не был инициирован');
    expect(bridge).toContain('turn_detection: null');
    expect(bridge).toContain('commitLocalManagerTurn');
    expect(bridge).toContain('openaiRealtimeLongTurnEndpointSilenceMs');
    expect(bridge).toContain('Math.min(provider.longTurnThresholdMs, 700)');
    expect(bridge).toContain('assessUserTurnCompletion(logicalText');
    expect(bridge).toContain('waitForManagerContinuation(logicalText,');
    expect(bridge).toContain('continuationStartedBeforeTranscript');
    expect(bridge).toContain("type: 'input_audio_buffer.commit'");
    expect(bridge).not.toContain('openingRequested');
    expect(scenario).toContain('mediaSocket.onmediaended');
    expect(scenario).toContain('mediaSocket.onmediastarted');
    expect(bridge).toContain('speechToVoxPlaybackMs');
    expect(bridge).toContain("message.customEvent === 'media_status'");
    expect(bridge).toContain('deferred_until_response_finished');
    expect(bridge).toContain('endCallRequested');
    expect(bridge).toContain("if (session.connectionState === 'live_conversation' && decision.speakerType !== 'live_human') return");
    expect(bridge).toContain('finishAfterPlayback = true');
    expect(bridge).not.toContain('hangupAfterManagerFarewell');
    expect(bridge).not.toContain('ensureManagerFarewellHardDeadline');
    expect(bridge).toContain('answer_the_manager_question_before_ending');
    expect(bridge).toContain('uncertain_audio_is_not_enough_to_mute_line');
    expect(bridge).toContain("ttsTurn?.append(' До свидания.')");
    expect(bridge).not.toContain('suppressEndCallResponse = true');
    expect(bridge).toContain('detectVehicleEntityMismatch(session.subjectTitle, text)');
    expect(bridge).toContain('provider.transcriptionModel');
    expect(bridge).toContain("session.provider === 'openai'");
    expect(bridge).toContain('config.openaiRealtimeApiKey');
    expect(bridge).toContain('config.openaiRealtimeUrl');
    expect(bridge).toContain('Точно распознавай марки');
    expect(bridge).toContain('pendingProviderAudio.push(audio)');
    expect(bridge).toContain("eventType === 'session.updated'");
    expect(bridge).toContain('pcm16MeanAbsolute');
    expect(bridge).toContain('initialBurstPacketsRemaining = 8');
    expect(bridge).toContain("'gpt-realtime-2.1-mini'");
    expect(bridge).toContain("name: 'send_dtmf'");
    expect(bridge).toContain("name: 'skip_turn'");
    expect(bridge).toContain('classifyLiveSpeakerLocally');
    expect(bridge).toContain('classifyLiveSpeaker({');
    expect(bridge).toContain("action: 'set_output_enabled'");
    expect(bridge).toContain('ttsTurn.cancel()');
    expect(bridge).toContain('Nothing generated for automation may leak');
    expect(bridge).toContain("action: 'send_dtmf'");
    expect(scenario).toContain('call.sendDigits(digit)');
    expect(scenario).toContain('send("ivr_selected"');
    expect(scenario).toContain('mediaSocket.stopMediaTo(call)');
    expect(scenario).toContain('live manager confirmed, output enabled');
  });
});
