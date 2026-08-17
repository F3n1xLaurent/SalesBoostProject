import { describe, expect, it } from 'vitest';
import { calculateRecommendations, type RecommendationCall } from '../analytics/recommendations/engine';

const NOW = new Date('2026-08-17T12:00:00.000Z');

function call(index: number, patch: Partial<RecommendationCall> = {}): RecommendationCall {
  return {
    id: index,
    startedAt: new Date(NOW.getTime() - (index % 20) * 86_400_000),
    score: 70,
    outcome: 'completed',
    answerTimeSec: 5,
    phoneNumberTypeId: 'type-main',
    phoneNumberTypeName: 'Основной',
    phoneNumberOwnership: 'dealership',
    checklist: [{ code: 'INTRODUCTION', status: 'YES' }],
    ...patch,
  };
}

describe('calculateRecommendations', () => {
  it('returns insufficient data below five evaluated calls', () => {
    const result = calculateRecommendations({ calls: [0, 1, 2, 3].map((index) => call(index)), now: NOW });
    expect(result.state).toBe('insufficient_data');
    expect(result.evaluatedCalls).toBe(4);
    expect(result.minimumCalls).toBe(5);
  });

  it('still reports an independent missed-call signal without five evaluated conversations', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(index, {
      score: null,
      startedAt: new Date(NOW.getTime() - (index % 3 + 1) * 86_400_000),
      outcome: index < 3 ? 'no_answer' : 'completed',
    }));
    calls[0].startedAt = new Date(NOW.getTime() - 1 * 86_400_000);
    calls[1].startedAt = new Date(NOW.getTime() - 2 * 86_400_000);
    calls[2].startedAt = new Date(NOW.getTime() - 3 * 86_400_000);
    const result = calculateRecommendations({ calls, now: NOW });
    expect(result.state).toBe('findings');
    expect(result.quick.some((item) => item.kind === 'missed')).toBe(true);
  });

  it('counts PARTIAL as half a checklist problem and ranks by weighted effect', () => {
    const calls = [0, 1, 2, 3, 4].map((index) => call(index, {
      checklist: [
        { code: 'INTRODUCTION', status: index < 2 ? 'PARTIAL' : 'YES' },
        { code: 'NEEDS_DISCOVERY', status: index < 2 ? 'NO' : 'YES' },
      ],
    }));
    const result = calculateRecommendations({ calls, now: NOW });
    expect(result.state).toBe('findings');
    expect(result.quick[0]).toMatchObject({ kind: 'checklist', problemCode: 'NO_NEEDS_DISCOVERY', importance: 3.2 });
    expect(result.quick.some((item) => item.problemCode === 'NO_INTRO_COMPANY')).toBe(false);
  });

  it('returns the strongest sub-threshold checklist item as a growth point', () => {
    const calls = [0, 1, 2, 3, 4].map((index) => call(index, {
      checklist: [{ code: 'PRODUCT_MISINFORMATION', status: index === 0 ? 'PARTIAL' : 'YES' }],
    }));
    const result = calculateRecommendations({ calls, now: NOW });
    expect(result.state).toBe('normal');
    expect(result.growthPoint).toMatchObject({ problemCode: 'PRODUCT_MISINFORMATION', importance: 1.2 });
  });

  it('finds a lagging child and dilutes its effect by call share', () => {
    const weak = [0, 1, 2].map((index) => call(index, { id: `w${index}`, score: 40 }));
    const strong = [3, 4, 5, 6, 7].map((index) => call(index, { id: `s${index}`, score: 80 }));
    const result = calculateRecommendations({
      calls: [...weak, ...strong],
      children: [{ id: 'weak', name: 'Петров', calls: weak }, { id: 'strong', name: 'Сидоров', calls: strong }],
      now: NOW,
    });
    expect(result.quick.find((item) => item.kind === 'lagging')).toMatchObject({ entityId: 'weak', importance: 9.38 });
  });

  it('compares a source with all other sources of the same entity', () => {
    const weak = [0, 1, 2, 3, 4].map((index) => call(index, { score: 40, phoneNumberTypeId: 'avito', phoneNumberTypeName: 'Авито' }));
    const rest = [5, 6, 7, 8, 9].map((index) => call(index, { score: 70, phoneNumberTypeId: 'site', phoneNumberTypeName: 'Сайт' }));
    const result = calculateRecommendations({ calls: [...weak, ...rest], now: NOW });
    expect(result.quick.find((item) => item.kind === 'source')).toMatchObject({ sourceName: 'Авито', importance: 15 });
  });

  it('uses separate missed-call norms and requires three bad recent days', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(index, {
      startedAt: new Date(NOW.getTime() - (index % 3 + 1) * 86_400_000),
      outcome: index < 2 ? 'no_answer' : 'completed',
      phoneNumberOwnership: 'dealership',
    }));
    // Put a missed call on each of three days; 30% missed versus the allowed 5%.
    calls[0].outcome = 'no_answer'; calls[0].startedAt = new Date(NOW.getTime() - 1 * 86_400_000);
    calls[1].outcome = 'no_answer'; calls[1].startedAt = new Date(NOW.getTime() - 2 * 86_400_000);
    calls[2].outcome = 'no_answer'; calls[2].startedAt = new Date(NOW.getTime() - 3 * 86_400_000);
    const result = calculateRecommendations({ calls, now: NOW });
    expect(result.quick.find((item) => item.kind === 'missed')).toMatchObject({ ownership: 'dealership', importance: 39 });
  });

  it('requires slow answering on at least two consecutive days', () => {
    const calls = [0, 1, 2, 3, 4].map((index) => call(index, {
      startedAt: new Date(NOW.getTime() - (index < 3 ? 1 : 2) * 86_400_000),
      answerTimeSec: 20,
      phoneNumberOwnership: 'user',
    }));
    const result = calculateRecommendations({ calls, now: NOW });
    expect(result.quick.find((item) => item.kind === 'answer_speed')).toMatchObject({ ownership: 'user', importance: 15 });
  });

  it('detects an eight-point 30-day trend drop', () => {
    const current = [0, 1, 2, 3, 4].map((index) => call(index, { score: 60 }));
    const previous = [0, 1, 2, 3, 4].map((index) => call(index + 20, {
      id: `previous-${index}`,
      startedAt: new Date(NOW.getTime() - (35 + index) * 86_400_000),
      score: 75,
    }));
    const result = calculateRecommendations({ calls: [...current, ...previous], now: NOW });
    expect(result.systemic.find((item) => item.kind === 'trend')).toMatchObject({ importance: 15 });
  });

  it('localizes a non-systemic checklist problem to the affected child', () => {
    const children = ['one', 'two', 'three'].map((id, childIndex) => ({
      id,
      name: `Сотрудник ${id}`,
      calls: Array.from({ length: 5 }, (_, index) => call(childIndex * 5 + index, {
        id: `${id}-${index}`,
        checklist: [{ code: 'NEEDS_DISCOVERY', status: childIndex === 0 ? 'NO' : 'YES' }],
      })),
    }));
    const result = calculateRecommendations({ calls: children.flatMap((child) => child.calls), children, now: NOW });
    expect(result.quick.find((item) => item.kind === 'checklist')).toMatchObject({ entityId: 'one', entityName: 'Сотрудник one' });
  });

  it('marks an operational problem systemic only at sixty percent coverage', () => {
    const children = Array.from({ length: 5 }, (_, childIndex) => ({
      id: `child-${childIndex}`,
      name: `Сотрудник ${childIndex}`,
      calls: Array.from({ length: 10 }, (_, index) => call(childIndex * 20 + index, {
        id: `${childIndex}-${index}`,
        startedAt: new Date(NOW.getTime() - (index % 3 + 1) * 86_400_000),
        outcome: childIndex < 3 && index < 3 ? 'no_answer' : 'completed',
      })),
    }));
    const result = calculateRecommendations({ calls: children.flatMap((child) => child.calls), children, now: NOW });
    expect(result.systemic.find((item) => item.kind === 'missed')).toMatchObject({ metrics: { systemicShare: 60, affectedChildren: 3 } });
  });

  it('rechecks a systemic source against the higher-level benchmark', () => {
    const children = ['a', 'b', 'c'].map((id, childIndex) => ({
      id, name: id,
      calls: [
        ...Array.from({ length: 5 }, (_, index) => call(childIndex * 10 + index, { id: `${id}-source-${index}`, score: 40, phoneNumberTypeId: 'avito', phoneNumberTypeName: 'Авито' })),
        call(childIndex * 10 + 6, { id: `${id}-rest`, score: 70, phoneNumberTypeId: 'site', phoneNumberTypeName: 'Сайт' }),
      ],
    }));
    const parentCalls = [
      ...Array.from({ length: 5 }, (_, index) => call(index, { id: `parent-source-${index}`, score: 65, phoneNumberTypeId: 'avito' })),
      ...Array.from({ length: 5 }, (_, index) => call(index + 6, { id: `parent-rest-${index}`, score: 70, phoneNumberTypeId: 'site' })),
    ];
    const result = calculateRecommendations({ calls: children.flatMap((child) => child.calls), children, parentCalls, now: NOW });
    expect([...result.quick, ...result.systemic].some((item) => item.kind === 'source')).toBe(false);
  });
});
