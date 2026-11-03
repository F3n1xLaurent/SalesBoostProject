import React from 'react';
import { BrutalModal } from '../brutal-modal';

type Props = {
  open: boolean;
  title: string;
  saving?: boolean;
  nested?: boolean;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
};

export function DeleteConfirmModal({
  open,
  title,
  saving = false,
  nested = true,
  confirmLabel = 'Удалить',
  onCancel,
  onConfirm,
  children,
}: Props) {
  return (
    <BrutalModal
      open={open}
      nested={nested}
      hideClose
      onClose={onCancel}
      title={title}
      width="narrow"
      footer={(
        <div className="sa-unsaved-actions">
          <button type="button" className="sa-btn-outline" onClick={onCancel} disabled={saving}>
            Отмена
          </button>
          <button type="button" className="sa-btn-danger" onClick={onConfirm} disabled={saving}>
            {saving ? 'Удаляем...' : confirmLabel}
          </button>
        </div>
      )}
    >
      {children ?? null}
    </BrutalModal>
  );
}
