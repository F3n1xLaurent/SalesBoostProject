import { describe, expect, it } from 'vitest';
import { extractIvrPath, parseStoredIvrPath } from '../voice/ivrWebhook';

describe('IVR webhook path parsing', () => {
  it('reads an accumulated array path', () => {
    expect(extractIvrPath({ ivr_path: ['3', '2'] })).toEqual(['3', '2']);
  });

  it('reads nested and JSON-encoded paths', () => {
    expect(extractIvrPath({ details: { accumulated_path: '["1","4"]' } })).toEqual(['1', '4']);
  });

  it('appends a selected digit when no accumulated path is present', () => {
    expect(extractIvrPath({ selected_digit: '7' }, ['3'])).toEqual(['3', '7']);
  });

  it('parses a stored path for API output', () => {
    expect(parseStoredIvrPath('["3","2"]')).toEqual(['3', '2']);
  });
});
