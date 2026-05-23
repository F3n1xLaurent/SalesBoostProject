import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

type ToastType = 'info' | 'success' | 'error';

type ToastInput = {
  type?: ToastType;
  title: string;
  description?: string;
};

type ToastItem = Required<Pick<ToastInput, 'type' | 'title'>> & {
  id: number;
  description?: string;
};

type ToastContextValue = {
  showToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ICONS: Record<ToastType, string> = {
  info: 'i',
  success: '✓',
  error: '!',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    const id = Date.now() + Math.random();
    const nextToast: ToastItem = {
      id,
      type: toast.type ?? 'info',
      title: toast.title,
      description: toast.description,
    };

    setToasts((current) => [...current, nextToast]);
    window.setTimeout(() => dismissToast(id), 3000);
  }, [dismissToast]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sa-toast-stack" role="region" aria-label="Уведомления">
        {toasts.map((toast) => (
          <div key={toast.id} className={`sa-toast sa-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
            <div className="sa-toast__accent" aria-hidden="true" />
            <div className="sa-toast__icon" aria-hidden="true">{TOAST_ICONS[toast.type]}</div>
            <div className="sa-toast__content">
              <div className="sa-toast__title">{toast.title}</div>
              {toast.description && <div className="sa-toast__description">{toast.description}</div>}
            </div>
            <button type="button" className="sa-toast__close" onClick={() => dismissToast(toast.id)} aria-label="Скрыть уведомление">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
