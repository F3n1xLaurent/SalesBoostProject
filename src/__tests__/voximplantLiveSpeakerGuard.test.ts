import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('Voximplant live speaker gate', () => {
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
