import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranscriptionReviewNotice } from './TranscriptionReviewNotice';

describe('ASR review notice in call and trainer reports', () => {
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
