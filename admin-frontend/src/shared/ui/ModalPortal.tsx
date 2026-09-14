import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll, unlockBodyScroll } from '../lib/body-scroll-lock';

type Props = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  modalClassName?: string;
  overlayClassName?: string;
  exitDurationMs?: number;
};

export function ModalPortal(props: Props) {
  const [render, setRender] = useState(props.open);
  const [closing, setClosing] = useState(false);
  const renderRef = useRef(props.open);

  useEffect(() => {
    if (props.open) {
      renderRef.current = true;
      setRender(true);
      setClosing(false);
      return;
    }
    if (!renderRef.current) return;
    if (!props.exitDurationMs) {
      renderRef.current = false;
      setRender(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      renderRef.current = false;
      setRender(false);
      setClosing(false);
    }, props.exitDurationMs);
    return () => window.clearTimeout(timer);
  }, [props.open, props.exitDurationMs]);

  useEffect(() => {
    if (!render) return;
    lockBodyScroll();
    return () => {
      unlockBodyScroll();
    };
  }, [render]);

  if (!render) return null;

  return createPortal(
    <div
      className={['sa-modal-overlay', 'theme-brutal', props.overlayClassName, closing ? 'is-closing' : '']
        .filter(Boolean)
        .join(' ')}
      onClick={closing ? undefined : props.onClose}
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
