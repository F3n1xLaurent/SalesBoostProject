import { describe, expect, it } from 'vitest';
import { autoTestRunPath, autoTestRunSearch, validAutoTestRunId } from './autoTestRunId';
import { testingTabSearch } from './testingTabs';

describe('persistent autotest links', () => {
  it('keeps report IDs and clears them without changing the report target', () => {
    const url = new URL(autoTestRunPath('report-run', 'report'), 'https://test.local');
    expect(url.searchParams.get('target')).toBe('report'); expect(url.searchParams.get('runId')).toBe('report-run');
    expect(autoTestRunSearch(url.search, null, 'report')).toBe('?tab=autotesting&target=report');
  });
  it('links to an exact saved run instead of whichever report happens to be latest', () => {
    expect(autoTestRunPath('a-b-c')).toBe('/testing?tab=autotesting&runId=a-b-c');
    expect(autoTestRunSearch('?callId=call&tab=hypotheses', 'old-run')).toBe('?callId=call&tab=autotesting&runId=old-run');
    expect(autoTestRunSearch('?tab=autotesting&runId=old-run', null)).toBe('?tab=autotesting');
  });
  it('preserves the chosen run when switching testing tabs', () => {
    expect(testingTabSearch('?tab=autotesting&runId=saved', 'hypotheses')).toBe('?runId=saved');
    expect(testingTabSearch('?runId=saved', 'autotesting')).toBe('?runId=saved&tab=autotesting');
  });
  it('keeps trainer links in the trainer target instead of opening the phone archive', () => {
    const url = new URL(autoTestRunPath('trainer-run', 'trainer'), 'https://test.local');
    expect(url.searchParams.get('target')).toBe('trainer'); expect(url.searchParams.get('runId')).toBe('trainer-run');
    expect(new URLSearchParams(autoTestRunSearch(url.search, null, 'trainer')).get('runId')).toBeNull();
    expect(new URLSearchParams(autoTestRunSearch(url.search, 'phone-run')).get('target')).toBeNull();
  });
  it('accepts current UUIDs and old safe IDs but blocks unsafe paths', () => {
    expect(validAutoTestRunId('c654237c-211a-40a9-88cd-88cc9c258cf4')).toBe(true);
    expect(validAutoTestRunId('old-report')).toBe(true);
    for (const id of ['../report', '/root', '', 'id with space', 'a'.repeat(65), 'a?b']) expect(validAutoTestRunId(id)).toBe(false);
  });
});
