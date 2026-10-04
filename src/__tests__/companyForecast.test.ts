import { describe, expect, it } from 'vitest';
import { calculateCompanyForecast } from '../economics/companyForecast';

describe('company economics forecast', () => {
  const benchmarks = {
    telephonyPerMinute: [1, 2, 4],
    aiPerCall: [0.5, 1, 2],
    sources: { telephonyCalls: 3, aiCalls: 3, fallbackTelephony: false },
  };

  it('calculates monthly call volume and three cost scenarios', () => {
    const result = calculateCompanyForecast({
      locations: 2,
      employeesPerLocation: 3,
      callsPerEmployeePerDay: 10,
      averageCallDurationSeconds: 120,
    }, benchmarks);
    expect(result.monthlyCalls).toBe(1800);
    expect(result.monthlyMinutes).toBe(3600);
    expect(result.scenarios.map((scenario) => scenario.key)).toEqual(['best', 'median', 'worst']);
    expect(result.scenarios[1]).toMatchObject({
      components: { telephony: 7200, ai: 1800, phoneNumbers: 0 },
      totalRub: 9000,
    });
    expect(result.scenarios[2].totalRub).toBeGreaterThan(result.scenarios[1].totalRub);
  });

  it('reports unavailable AI benchmarks instead of inventing a price', () => {
    const result = calculateCompanyForecast({
      locations: 1, employeesPerLocation: 1, callsPerEmployeePerDay: 1, averageCallDurationSeconds: 60,
    }, { ...benchmarks, aiPerCall: [], sources: { ...benchmarks.sources, aiCalls: 0 } });
    expect(result.scenarios[1].components.ai).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/ProxyAPI/);
  });
});
