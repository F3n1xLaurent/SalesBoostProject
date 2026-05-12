import styled from '@emotion/styled';
import type { ReactNode } from 'react';

type StatusNoticeTone = 'warning' | 'neutral';

const TONE_STYLES: Record<StatusNoticeTone, { background: string; border: string; color: string }> = {
  warning: {
    background: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)',
    border: '1px solid rgba(245,158,11,0.3)',
    color: '#92400E',
  },
  neutral: {
    background: 'var(--sa-surface-muted)',
    border: '1px solid var(--sa-border)',
    color: 'var(--sa-text)',
  },
};

const Notice = styled.div<{ tone: StatusNoticeTone }>`
  margin-bottom: 24px;
  padding: 20px;
  border-radius: 18px;
  font-size: 14px;
  background: ${({ tone }) => TONE_STYLES[tone].background};
  border: ${({ tone }) => TONE_STYLES[tone].border};
  color: ${({ tone }) => TONE_STYLES[tone].color};

  code {
    background: rgba(0, 0, 0, 0.06);
    padding: 2px 8px;
    border-radius: 6px;
  }
`;

export function StatusNotice({ tone = 'neutral', children }: { tone?: StatusNoticeTone; children: ReactNode }) {
  return <Notice tone={tone}>{children}</Notice>;
}
