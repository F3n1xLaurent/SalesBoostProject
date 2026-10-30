import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTestingTab, testingTabSearch } from '../../admin-frontend/src/pages/testing/model/testingTabs';
import { checkGuidance } from '../../admin-frontend/src/pages/testing/model/checkGuidance';
import { REGRESSION_CHECKLIST } from '../voice/realtimeRegressionScenarios';

describe('testing tabs and extensible checks', () => {
  it('keeps hypotheses as default and supports direct links to autotesting', () => {
    expect(parseTestingTab('')).toBe('hypotheses');
    expect(parseTestingTab('?tab=autotesting')).toBe('autotesting');
    expect(parseTestingTab('?tab=unknown')).toBe('hypotheses');
    expect(testingTabSearch('?callId=existing', 'autotesting')).toBe('?callId=existing&tab=autotesting');
    expect(testingTabSearch('?tab=autotesting&callId=existing', 'hypotheses')).toBe('?callId=existing');
  });
  it('provides an understandable explanation for every certified checklist item', () => {
    for (const [id] of REGRESSION_CHECKLIST) expect(checkGuidance[id]?.length).toBeGreaterThan(40);
  });
  it('moves the regression block out of hypotheses and keeps both tab panels mounted', () => {
    const hypotheses = readFileSync('admin-frontend/src/pages/testing/ui/YandexRealtimeTestPage.tsx', 'utf8');
    const page = readFileSync('admin-frontend/src/pages/testing/ui/TestingPage.tsx', 'utf8');
    const auto = readFileSync('admin-frontend/src/pages/testing/ui/AutoTestingPage.tsx', 'utf8');
    expect(hypotheses).not.toContain('RealtimeRegressionPanel');
    expect(page).toContain('Гипотезы'); expect(page).toContain('Автотестирование');
    expect(page).toContain("hidden={tab !== 'hypotheses'}"); expect(page).toContain("hidden={tab !== 'autotesting'}");
    expect(auto).toContain('RealtimeRegressionPanel'); expect(auto).toContain('Сами проверки ещё не реализованы');
  });
  it('proxies WebSockets in development and documents the production upgrade without ticket access logs', () => {
    const vite = readFileSync('admin-frontend/vite.config.ts', 'utf8');
    const nginx = readFileSync('nginx.prod.conf.example', 'utf8');
    expect(vite).toContain("'/api': { target: 'http://localhost:3000', ws: true }");
    const location = nginx.slice(nginx.indexOf('location ~ ^/api/admin/auto-testing/'));
    expect(location.slice(0, location.indexOf('}') + 1)).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(location.slice(0, location.indexOf('}') + 1)).toContain('access_log off;');
  });
});
