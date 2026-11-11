import { describe, expect, it } from 'vitest';
import { filterDemoCalls, parseDemoCallNumericId, type DemoCallSearchRow } from '../analytics/demoCallSearch';

const row: DemoCallSearchRow = {
  id: 1234, callId: 'b893e174-3299-4bee-8373-9219fe87ab43',
  phone: '+79991234567', ipAddress: '192.168.1.20',
  startedAt: '2026-11-11T07:35:00.000Z', outcome: 'no_answer',
  durationSec: 83, totalScore: 75.6, error: 'Ошибка распознавания',
  ivrDetected: true, ivrPath: ['1', '2'],
};
const match = (query: string) => filterDemoCalls([row], query).map(item => item.id);

describe('demo call table search', () => {
  it.each(['1234', '#1234', 'call-1234', row.callId, row.callId.toUpperCase(), '3299-4bee'])('finds a call by numeric id or UUID: %s', query => {
    expect(match(query)).toEqual([1234]);
  });
  it.each(['+79991234567', '192.168.1.20', 'Нет ответа', '11.11.2026', '10:35', '1:23', '83', '75,6', '76/100', 'распознавания', 'IVR 1-2'])('searches row values and Moscow display formats: %s', query => {
    expect(match(query)).toEqual([1234]);
  });
  it('allows several search words across different columns', () => {
    expect(match('нет ответа 192.168.1.20')).toEqual([1234]);
    expect(match('нет ответа отсутствует')).toEqual([]);
  });
  it('finds older calls before limiting the table to the last 100 matches', () => {
    const recent = Array.from({ length: 100 }, (_, i) => ({ ...row, id: i + 1, callId: `recent-${i}` }));
    expect(filterDemoCalls([...recent, row], row.callId).slice(0, 100)).toEqual([row]);
  });
  it('handles empty search and missing optional values', () => {
    expect(match('   ')).toEqual([1234]);
    expect(filterDemoCalls([{ ...row, totalScore: null, durationSec: null, error: null, ipAddress: null, ivrDetected: false }], 'IVR')).toEqual([]);
  });
  it('uses only valid Prisma Int ids, so a numeric phone does not break the global query', () => {
    expect(parseDemoCallNumericId('#1234')).toBe(1234);
    expect(parseDemoCallNumericId('call-1234')).toBe(1234);
    for (const value of ['79991234567', '9007199254740993', '0', '-1', '1.5', row.callId]) {
      expect(parseDemoCallNumericId(value)).toBeNull();
    }
  });
});
