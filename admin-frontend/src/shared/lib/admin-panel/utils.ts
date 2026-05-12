/**
 * Shared UI utility functions for the Super Admin panel.
 * Centralises color-class logic, delta formatting, badge class generation
 * so that all pages (Dashboard, Автосалоны, Сотрудники, detail pages) use
 * the same rules without duplication.
 */

export function ratingClass(v: number): string {
  if (v >= 80) return 'sa-score-green';
  if (v >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

export function answerRateClass(v: number | null): string {
  if (v === null) return '';
  if (v >= 80) return 'sa-score-green';
  if (v >= 60) return 'sa-score-orange';
  return 'sa-score-red';
}

export function answerTimeClass(v: number | null): string {
  if (v === null) return '';
  if (v <= 15) return 'sa-score-green';
  if (v <= 30) return 'sa-score-orange';
  return 'sa-score-red';
}

export function deltaDisplay(d: number | null): { text: string; cls: string } {
  if (d === null) return { text: '—', cls: '' };
  const sign = d > 0 ? '+' : '';
  const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '';
  const cls = d > 0 ? 'sa-score-green' : d < -5 ? 'sa-score-red' : d < 0 ? 'sa-score-orange' : '';
  return { text: `${sign}${d} ${arrow}`, cls };
}

export function statusBadgeClass(s: string): string {
  return `sa-status-badge sa-status-${s}`;
}

export function exportPageToPdf(fileName: string): void {
  if (typeof window === 'undefined') return;
  const previousTitle = document.title;
  document.title = fileName;
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 500);
}
