import React from 'react';
import { FlowButton } from '../../landing/ui/FlowButton';
import type { UnavailableCall } from '../model/unavailableCall';

export function DemoCallUnavailable({ kind, phone, loading, onRetry, onReset }: {
  kind: UnavailableCall;
  phone: string;
  loading: boolean;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <div className="demo-stand-stack demo-wait-scene demo-call-unavailable" role="status">
      <div className="demo-wait-card">
        <div className="demo-wait-visual-slot">
          <div className="demo-wait-pulse" aria-hidden>
            <span className="demo-wait-pulse__ring" />
            <span className="demo-wait-pulse__ring" />
            <span className="demo-wait-pulse__core">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 3 18 18M10.7 13.3a16 16 0 0 0 2.5 2l2.2-2.2a1 1 0 0 1 1-.2c1.1.4 2.3.6 3.6.6a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.6 3.6a1 1 0 0 1-.2 1l-.6.6" />
              </svg>
            </span>
          </div>
        </div>
        <h2 className="demo-wait-card__title">
          {kind === 'missed' ? 'Не удалось дозвониться' : 'Не удалось разобрать разговор'}
        </h2>
        <div className="demo-wait-card__copy">
          <p className="demo-wait-card__text">Попробуйте ещё раз или укажите другой номер.</p>
        </div>
        <div className="demo-wait-phone-slot">
          {phone && <div className="demo-wait-phone">{phone}</div>}
        </div>
      </div>
      <div className="demo-call-unavailable__actions">
        {phone && <FlowButton text={loading ? 'Звоним…' : 'Позвонить ещё раз'} type="button" variant="solid"
          disabled={loading} onClick={onRetry} className="demo-stand-action" />}
        <FlowButton text="Ввести другой номер" type="button" disabled={loading} onClick={onReset} className="demo-stand-action" />
      </div>
    </div>
  );
}
