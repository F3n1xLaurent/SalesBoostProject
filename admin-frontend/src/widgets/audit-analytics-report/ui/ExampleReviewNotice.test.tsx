import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExampleReviewNotice } from './ExampleReviewNotice';

describe('example review notice', () => {
  it('keeps reasons compact and distinguishes a rejected example from a provider outage', () => {
    const html = renderToStaticMarkup(<ExampleReviewNotice items={[
      { turnIndex: 1, exampleHash: 'a', status: 'fail', issues: ['Нет ответа про дождь.'] },
      { turnIndex: 3, exampleHash: 'b', status: 'review', issues: ['Проверка недоступна.'] },
      { turnIndex: 5, exampleHash: 'c', status: 'pass', issues: [] },
    ]} />);
    expect(html).toContain('<details'); expect(html).toContain('Примеры требуют проверки: 2');
    expect(html).toContain('Реплика 2'); expect(html).toContain('Нет ответа про дождь.');
    expect(html).toContain('нужна проверка'); expect(html).not.toContain('Реплика 6');
    expect(html).toContain('не дополнительный штраф');
  });
  it('renders nothing for old reports and verified examples', () => {
    expect(renderToStaticMarkup(<ExampleReviewNotice />)).toBe('');
    expect(renderToStaticMarkup(<ExampleReviewNotice items={[{ turnIndex: 1, exampleHash: 'x', status: 'pass', issues: [] }]} />)).toBe('');
  });
});
