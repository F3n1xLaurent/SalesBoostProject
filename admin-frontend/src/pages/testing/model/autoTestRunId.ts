export const validAutoTestRunId = (id: string) => /^[a-z0-9-]{1,64}$/i.test(id);
export function autoTestRunSearch(search: string, id: string | null, target: 'call_plan' | 'trainer' | 'report' = 'call_plan'): string {
  const params = new URLSearchParams(search);
  params.set('tab', 'autotesting');
  if (target !== 'call_plan') params.set('target', target); else params.delete('target');
  if (id) params.set('runId', id); else params.delete('runId');
  return `?${params.toString()}`;
}
export function autoTestRunPath(id: string, target: 'call_plan' | 'trainer' | 'report' = 'call_plan'): string {
  return `/testing${autoTestRunSearch('', id, target)}`;
}
