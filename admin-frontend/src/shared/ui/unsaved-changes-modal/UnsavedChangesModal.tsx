import React from 'react';
import { BrutalModal } from '../brutal-modal';

type Props = {
  open: boolean;
  saving?: boolean;
  onDiscard: () => void;
  onCancel: () => void;
  onSave: () => void;
};

export function UnsavedChangesModal({ open, saving = false, onDiscard, onCancel, onSave }: Props) {
  return (
    <BrutalModal
      open={open}
      nested
      hideClose
      onClose={onCancel}
      title="Сохранить изменения?"
      width="narrow"
      footer={(
        <div className="sa-unsaved-actions">
          <button type="button" className="sa-btn-outline" onClick={onDiscard} disabled={saving}>
            Не сохранять
          </button>
          <button type="button" className="sa-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </div>
      )}
    >
      {null}
    </BrutalModal>
  );
}
