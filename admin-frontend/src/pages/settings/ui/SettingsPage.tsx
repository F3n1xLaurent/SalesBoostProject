import React, { useState } from 'react';
import { changeOwnPassword, type AdminPanelSettings } from '../../../shared/api/adminPanel';

type SettingsProps = {
  settings: AdminPanelSettings | null;
  loading?: boolean;
};

export function Settings({ settings: _settings, loading: _loading = false }: SettingsProps) {
  const [password, setPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function handleChangePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordNotice(null);
    setPasswordError(null);
    if (!password) {
      setPasswordError('Введите новый пароль.');
      return;
    }
    setSavingPassword(true);
    try {
      await changeOwnPassword(password);
      setPassword('');
      setPasswordNotice('Пароль успешно изменен');
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'Не удалось изменить пароль.');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="sa-page-enter">
      <h1 className="sa-page-title">Настройки</h1>
      <p className="sa-meta" style={{ marginBottom: 24 }}>Управление аккаунтом</p>

      <section className="sa-card sa-brutal-card">
        <div className="sa-brutal-card-header">
          <span className="sa-brutal-card-title">Смена пароля</span>
        </div>
        <div className="sa-brutal-card-body">
          <form onSubmit={handleChangePassword} style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span className="sa-meta">Новый пароль</span>
              <input
                type="password"
                className="sa-input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            {passwordNotice && (
              <div style={{ padding: 12, borderRadius: 14, background: '#ecfdf5', color: '#047857', fontSize: 14 }}>
                {passwordNotice}
              </div>
            )}
            {passwordError && (
              <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
                {passwordError}
              </div>
            )}
            <div>
              <button type="submit" className="sa-btn-brutal-3d" disabled={savingPassword || !password}>
                {savingPassword ? 'Изменяем...' : 'Изменить пароль'}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
