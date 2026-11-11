import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionReviewNotice } from './TranscriptionReviewNotice';

const mode = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../entities/session/model/useDevMode', () => ({ useDevMode: () => ({ devMode: mode.enabled }) }));
beforeEach(() => { mode.enabled = true; });

describe('ASR review notice in call and trainer reports', () => {
  it('hides the entire block when superadmin DEV mode is off', () => {
    mode.enabled = false;
    expect(renderToStaticMarkup(<TranscriptionReviewNotice items={[{ turnIndex: 1, quote: 'Спорный фрагмент', reason: 'Нужно сверить запись.' }]} />)).toBe('');
  });
  it('shows the actual disputed text without calling it a proven manager mistake', () => {
    const html = renderToStaticMarkup(<TranscriptionReviewNotice items={[{ turnIndex: 1, quote: 'Обслуживание за 2006 год', reason: 'Нужно сверить запись.' }]} />);
    expect(html).toContain('Нужно проверить запись');
    expect(html).toContain('2006'); expect(html).toContain('Реплика 2');
    expect(html).toContain('не считаются доказанной ошибкой');
  });
  it('does not introduce an empty review block into ordinary reports', () => {
    expect(renderToStaticMarkup(<TranscriptionReviewNotice />)).toBe('');
  });
});
