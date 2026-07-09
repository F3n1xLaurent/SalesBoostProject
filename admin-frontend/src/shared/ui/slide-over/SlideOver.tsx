import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type SlideOverProps = {
  open: boolean;
  title?: string;
  children: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
  onClose: () => void;
};

const SLIDE_OVER_ANIMATION_MS = 220;

export function SlideOver({ open, title, children, width = 'xl', onClose }: SlideOverProps) {
  const [rendered, setRendered] = useState(open);
  const [visibleTitle, setVisibleTitle] = useState(title);
  const [visibleChildren, setVisibleChildren] = useState(children);

  useEffect(() => {
    if (!open) return;
    setRendered(true);
    setVisibleTitle(title);
    setVisibleChildren(children);
  }, [children, open, title]);

  useEffect(() => {
    if (open || !rendered) return;
    const timeout = window.setTimeout(() => setRendered(false), SLIDE_OVER_ANIMATION_MS);
    return () => window.clearTimeout(timeout);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, rendered]);

  if (!rendered) return null;

  const closing = !open;

  return createPortal(
    <div
      className={`sa-slide-over theme-brutal ${closing ? 'sa-slide-over-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={visibleTitle || 'Боковая панель'}
    >
      <button type="button" className="sa-slide-over-backdrop" aria-label="Закрыть" onClick={onClose} />
      <aside className={`sa-slide-over-panel sa-slide-over-panel-${width}`}>
        <button type="button" className="sa-slide-over-close" aria-label="Закрыть" onClick={onClose}>
          x
        </button>
        {visibleTitle && (
          <div className="sa-slide-over-header">
            <h2>{visibleTitle}</h2>
          </div>
        )}
        <div className="sa-slide-over-body">{visibleChildren}</div>
      </aside>
    </div>,
    document.body,
  );
}
