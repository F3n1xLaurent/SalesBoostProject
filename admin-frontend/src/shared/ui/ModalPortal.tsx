import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll, unlockBodyScroll } from '../lib/body-scroll-lock';

type Props = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  modalClassName?: string;
  overlayClassName?: string;
};

export function ModalPortal(props: Props) {
  useEffect(() => {
    if (!props.open) return;
    lockBodyScroll();
    return () => {
      unlockBodyScroll();
    };
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <div
      className={['sa-modal-overlay', 'theme-brutal', props.overlayClassName].filter(Boolean).join(' ')}
      onClick={props.onClose}
    >
      <div
        className={['sa-modal', props.modalClassName].filter(Boolean).join(' ')}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {props.children}
      </div>
    </div>,
    document.body,
  );
}
