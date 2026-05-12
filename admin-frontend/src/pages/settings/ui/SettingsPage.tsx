import React, { useState } from 'react';
import { changeOwnPassword, type AdminPanelSettings } from '../../../shared/api/adminPanel';

type SettingsProps = {
  settings: AdminPanelSettings | null;
  loading?: boolean;
};

export function Settings({ settings, loading = false }: SettingsProps) {
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
    <>
      <h1 className="sa-page-title">Настройки</h1>
      <p className="sa-meta" style={{ marginBottom: 32 }}>Параметры платформы и аккаунта</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 24 }}>
        <div className="sa-card">
          <div className="sa-meta">Скрипты</div>
          <div className="sa-kpi-value" style={{ fontSize: 32 }}>{loading ? '—' : settings?.totalScripts ?? '—'}</div>
        </div>
        <div className="sa-card">
          <div className="sa-meta">Номера телефонов</div>
          <div className="sa-kpi-value" style={{ fontSize: 32 }}>{loading ? '—' : settings?.totalPhones ?? '—'}</div>
        </div>
        <div className="sa-card">
          <div className="sa-meta">Язык платформы</div>
          <div className="sa-kpi-value" style={{ fontSize: 28 }}>{loading ? '—' : settings?.platformLanguage ?? 'RU / KZ'}</div>
        </div>
        <div className="sa-card">
          <div className="sa-meta">Телефония</div>
          <div className="sa-kpi-value" style={{ fontSize: 24 }}>{loading ? '—' : settings?.telephonyProvider ?? '—'}</div>
        </div>
      </div>

      <section className="sa-card" style={{ marginTop: 24, padding: 20, maxWidth: 560 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 22 }}>Смена пароля</h2>
        <form onSubmit={handleChangePassword} style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Новый пароль</span>
            <input
              type="password"
              className="sa-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          {passwordNotice && <div style={{ padding: 12, borderRadius: 14, background: '#ecfdf5', color: '#047857', fontSize: 14 }}>{passwordNotice}</div>}
          {passwordError && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{passwordError}</div>}
          <div>
            <button type="submit" className="sa-btn-primary" disabled={savingPassword || !password}>
              {savingPassword ? 'Изменяем...' : 'Изменить'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
