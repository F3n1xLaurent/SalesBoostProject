import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  modalClassName?: string;
};

export function ModalPortal(props: Props) {
  useEffect(() => {
    if (!props.open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <div className="sa-modal-overlay theme-brutal" onClick={props.onClose}>
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
