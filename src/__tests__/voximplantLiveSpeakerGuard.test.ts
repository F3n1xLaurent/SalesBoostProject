import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isTerminalAutomatedAnswer as isTerminalAnswerOnServer } from '../voice/terminalAutomatedAnswer';

const scenarioSource = readFileSync(resolve(process.cwd(), 'voximplant/last_actual_realtime.js'), 'utf8');

function scenarioFunction(name: string): (text: string) => boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = scenarioSource.match(new RegExp(`  function ${escapedName}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  if (!match) throw new Error(`Voximplant scenario function not found: ${name}`);
  // The extracted functions contain only deterministic regular expressions.
  return Function(`"use strict"; return (${match[0].trim()});`)() as (text: string) => boolean;
}

const isAutomatedOrWaitingMessage = scenarioFunction('isAutomatedOrWaitingMessage');
const isClearlyLiveHuman = scenarioFunction('isClearlyLiveHuman');
const isTerminalAutomatedAnswer = scenarioFunction('isTerminalAutomatedAnswer');

describe('Voximplant live speaker gate', () => {
  it.each([
    ['Приветствую! Линия абонента сейчас занята. Что важного ему передать?', true],
    ['Я голосовой ассистент Мия. Запишу всё слово в слово. Попробуем?', true],
    ['Здравствуйте! Это виртуальная помощница.', true],
    ['Абонент недоступен. Оставьте сообщение после сигнала.', true],
    ['Для соединения с отделом продаж нажмите 1.', false],
    ['Я голосовой ассистент. Выберите отдел, нажмите 1.', false],
    ['Все операторы заняты. Дождитесь ответа, оставайтесь на линии.', false],
    ['Я занят, перезвоните завтра.', false],
  ])('agrees with the server on terminal automation: %s', (text, terminal) => {
    expect(isTerminalAutomatedAnswer(String(text))).toBe(terminal);
    expect(isTerminalAnswerOnServer(text)).toBe(terminal);
  });

  it('hangs up on the first Mia greeting without waiting for the model or classifier', () => {
    const finish = vi.fn();
    const mute = vi.fn();
    const stored: unknown[] = [];
    const match = scenarioSource.match(/  function handleUserTranscript\([^)]*\) \{[\s\S]*?\n  \}/);
    expect(match).not.toBeNull();
    const handle = Function('isTerminalAutomatedAnswer', 'finishWithEvent', 'muteAgentOutput', 'pushTranscript', `
      var conversationRevision = 0, liveDetectionRevision = 0, pendingLiveClassification = null, agentMediaActive = false;
      function normalizeInputTranscript(text) { return text.toLowerCase(); }
      function cancelPendingNaturalEnd() {}
      return (${match![0].trim()});
    `)(isTerminalAutomatedAnswer, finish, mute, (role: string, text: string) => stored.push({ role, text }));
    handle('Приветствую! Линия абонента сейчас занята. Что важного ему передать?');
    expect(finish).toHaveBeenCalledWith('no_answer', { reason: 'voicemail', detected_by: 'local_line_guard' });
    expect(mute).toHaveBeenCalledWith('terminal_automated_answer');
    expect(stored).toHaveLength(1);
  });
  it('keeps the recorded greeting from call 786 muted', () => {
    const greeting = 'Салон «Автомобильная группа» приветствует вас!';
    expect(isAutomatedOrWaitingMessage(greeting)).toBe(true);
    expect(isClearlyLiveHuman(greeting)).toBe(false);
  });

  it('keeps a recorded greeting muted even when it also contains a normal greeting', () => {
    const greeting = 'Здравствуйте! Вас приветствует компания «Автогарант».';
    expect(isAutomatedOrWaitingMessage(greeting)).toBe(true);
    expect(isClearlyLiveHuman(greeting)).toBe(true);
    // The production gate checks automation first, before this fast path.
    expect(!isAutomatedOrWaitingMessage(greeting) && isClearlyLiveHuman(greeting)).toBe(false);
  });

  it('accepts standard greetings without waiting for the remote classifier', () => {
    expect(isClearlyLiveHuman('Здравствуйте!')).toBe(true);
    expect(isClearlyLiveHuman('Добрый день, компания Автогарант.')).toBe(true);
    expect(isClearlyLiveHuman('Доброе утро.')).toBe(true);
    expect(isClearlyLiveHuman('Добрый вечер.')).toBe(true);
  });

  it('does not accept a company name alone as proof of a live person', () => {
    expect(isClearlyLiveHuman('Автосалон на связи.')).toBe(false);
  });

  it('accepts explicitly interactive live replies', () => {
    expect(isClearlyLiveHuman('Алло.')).toBe(true);
    expect(isClearlyLiveHuman('Да?')).toBe(true);
    expect(isClearlyLiveHuman('Здравствуйте, слушаю вас.')).toBe(true);
    expect(isClearlyLiveHuman('Добрый день, чем могу помочь?')).toBe(true);
    expect(isClearlyLiveHuman('Меня зовут Анна.')).toBe(true);
    expect(isClearlyLiveHuman('Алексей, менеджер отдела продаж.')).toBe(true);
  });

  it('keeps bots and answering machines muted', () => {
    expect(isAutomatedOrWaitingMessage('Это автоматический помощник.')).toBe(true);
    expect(isAutomatedOrWaitingMessage('Оставьте сообщение после сигнала.')).toBe(true);
  });
});
