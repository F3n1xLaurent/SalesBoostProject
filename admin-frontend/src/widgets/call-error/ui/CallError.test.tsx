import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallError } from './CallError';

const mode = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../entities/session/model/useDevMode', () => ({ useDevMode: () => ({ devMode: mode.enabled }) }));
beforeEach(() => { mode.enabled = false; });

describe('call failure visibility', () => {
  const technical = 'Pipecat HTTP 503: ElevenLabs ConnectError; pf-private-id';

  it('shows only a generic error outside DEV mode', () => {
    expect(renderToStaticMarkup(<CallError message={technical} />)).toBe('<div>Ошибка</div>');
  });

  it('omits extra history details when the row already has an error badge', () => {
    expect(renderToStaticMarkup(<CallError message={technical} detailsOnly />)).toBe('');
  });

  it('shows the original provider error only in DEV mode', () => {
    mode.enabled = true;
    expect(renderToStaticMarkup(<CallError message={technical} detailsOnly />)).toContain(technical);
  });

  it('does not add an error to a successful call', () => {
    expect(renderToStaticMarkup(<CallError message={null} />)).toBe('');
  });
});
