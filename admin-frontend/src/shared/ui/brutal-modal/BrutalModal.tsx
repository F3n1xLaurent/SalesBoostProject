import React from 'react';
import { ModalPortal } from '../ModalPortal';

type BrutalModalWidth = 'narrow' | 'medium' | 'wide' | number;

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: BrutalModalWidth;
  headerActions?: React.ReactNode;
  hideClose?: boolean;
  nested?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function widthClassName(width: BrutalModalWidth | undefined): string {
  if (width === 'wide') return 'sa-modal-wide';
  if (width === 'narrow') return 'sa-modal-narrow';
  if (typeof width === 'number') return width >= 900 ? 'sa-modal-wide' : 'sa-modal-medium';
  return 'sa-modal-medium';
}

export function BrutalModal({
  open,
  onClose,
  title,
  subtitle,
  width = 'medium',
  headerActions,
  hideClose = false,
  nested = false,
  footer,
  children,
}: Props) {
  const showHeaderActions = Boolean(headerActions) || !hideClose;
  const centeredHeader = hideClose && !headerActions;

  return (
    <ModalPortal
      open={open}
      onClose={onClose}
      modalClassName={[
        widthClassName(width),
        footer ? 'sa-modal--with-footer' : '',
        centeredHeader ? 'sa-modal--centered' : '',
      ].filter(Boolean).join(' ')}
      overlayClassName={nested ? 'sa-modal-overlay-nested' : undefined}
    >
      <div className={`sa-modal-header${centeredHeader ? ' sa-modal-header--centered' : ''}`}>
        <div className="sa-modal-heading">
          <h2 className="sa-modal-title">{title}</h2>
          {subtitle ? <p className="sa-modal-subtitle">{subtitle}</p> : null}
        </div>
        {showHeaderActions ? (
          <div className="sa-modal-header-actions">
            {headerActions}
            {!hideClose ? (
              <button
                type="button"
                className="sa-btn-brutal-3d sa-modal-close"
                onClick={onClose}
                aria-label="Закрыть"
                title="Закрыть"
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {children != null && children !== false ? <div className="sa-modal-body">{children}</div> : null}
      {footer ? <div className="sa-modal-footer">{footer}</div> : null}
    </ModalPortal>
  );
}
