import React from 'react';
import type { AdminPanelSettings } from '../../../shared/api/adminPanel';

type SettingsProps = {
  settings: AdminPanelSettings | null;
  loading?: boolean;
};

export function Settings({ settings, loading = false }: SettingsProps) {
  return (
    <>
      <h1 className="sa-page-title">Настройки</h1>
      <p className="sa-meta" style={{ marginBottom: 32 }}>Только для просмотра</p>

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
    </>
  );
}
