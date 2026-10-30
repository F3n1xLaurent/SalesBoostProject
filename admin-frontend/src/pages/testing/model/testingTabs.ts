export type TestingTab = 'hypotheses' | 'autotesting';
export function parseTestingTab(search: string): TestingTab {
  return new URLSearchParams(search).get('tab') === 'autotesting' ? 'autotesting' : 'hypotheses';
}
export function testingTabSearch(search: string, tab: TestingTab): string {
  const params = new URLSearchParams(search);
  if (tab === 'hypotheses') params.delete('tab'); else params.set('tab', tab);
  const query = params.toString(); return query ? `?${query}` : '';
}
