import React, { useState } from 'react';
import { apiFetch } from '../../../../entities/session';
import type { RbacMeta } from '../../../../shared/api/adminPanel';
import { BrutalModal } from '../../../../shared/ui/brutal-modal';
import { parseEmployeeImportCsv, type EmployeeImportRow } from '../../model/employeeImportCsv';
type Preview = {
  valid: boolean;
  total: number;
  rows: {
    line: number;
    email: string;
    fullName: string;
    branchName: string;
    errors: string[];
  }[];
};
export function EmployeeImportModal({ meta, initialCompanyId, onClose, onImported }: {
  meta: RbacMeta;
  initialCompanyId: string;
  onClose: () => void;
  onImported: (count: number) => Promise<void>;
}) {
  const [companyId, setCompanyId] = useState(initialCompanyId || (meta.holdings.length === 1 ? meta.holdings[0].id : ''));
  const [branchId, setBranchId] = useState(''), [csv, setCsv] = useState(''), [fileName, setFileName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<Preview | null>(null), [rows, setRows] = useState<EmployeeImportRow[]>([]);
  const reset = () => { setPreview(null); setRows([]); setError(null); };
  const branches = meta.dealerships.filter(item => item.holdingId === companyId);
  const template = () => {
    const content = '\uFEFFemail;fullName;branchId;password;phone\r\n';
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'employees-template.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  async function validate() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const parsed = parseEmployeeImportCsv(csv, branchId);
      setRows(parsed);
      const response = await apiFetch('/api/admin/employees/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId, rows: parsed }) });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? 'Не удалось проверить файл.');
      setPreview(data);
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось прочитать CSV.');
    }
    finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/admin/employees/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId, rows }) });
      const data = await response.json();
      if (!response.ok) {
        if (data.rows)
          setPreview(data);
        throw new Error(data.error ?? 'Не удалось импортировать сотрудников.');
      }
      setCsv('');
      setRows([]);
      await onImported(data.importedCount);
      onClose();
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось импортировать сотрудников.');
    }
    finally {
      setBusy(false);
    }
  }
  return <BrutalModal open onClose={() => {
    if (!busy)
      onClose();
  }} title="Импорт сотрудников" width="wide" footer={<div className="sa-modal-footer-row"><div className="sa-modal-footer-row__right"><button type="button" className="sa-btn-outline" disabled={busy} onClick={onClose}>Отмена</button>{preview?.valid ? <button type="button" className="sa-btn-primary" disabled={busy} onClick={() => void commit()}>{busy ? 'Импортируем…' : `Импортировать ${preview.total} сотрудников`}</button> : <button type="button" className="sa-btn-primary" disabled={busy || !companyId || !csv} onClick={() => void validate()}>{busy ? 'Проверяем…' : 'Проверить файл'}</button>}</div></div>}>
    <div style={{ display: 'grid', gap: 18 }}>
      <p style={{ margin: 0, color: '#777' }}>Загрузите CSV в UTF-8, до 200 сотрудников. Обязательные колонки: email, fullName, password. Для каждого сотрудника укажите точку в branchId или выберите одну точку для всего файла. phone — необязательно. Пароль — от 8 до 128 символов.</p>
      <button type="button" className="sa-btn-outline" style={{ justifySelf: 'start' }} onClick={template}>Скачать шаблон CSV</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16 }}>
        <label>Компания<select className="sa-input" aria-label="Компания для импорта" disabled={busy} value={companyId} onChange={event => { setCompanyId(event.target.value); setBranchId(''); reset(); }}><option value="">Выберите компанию</option>{meta.holdings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Точка для строк без branchId<select className="sa-input" aria-label="Точка для импорта" disabled={busy || !companyId} value={branchId} onChange={event => { setBranchId(event.target.value); reset(); }}><option value="">Из колонки branchId</option>{branches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <label>Файл CSV<input className="sa-input" type="file" accept=".csv,text/csv" disabled={busy} onChange={async (event) => {
        const file = event.target.files?.[0]; reset(); setCsv(''); setFileName(file?.name ?? ''); if (!file)
          return; if (file.size > 2 * 1024 * 1024) {
            setError('Размер файла не должен превышать 2 МБ.');
            return;
          } try {
            setCsv(await file.text());
          }
        catch {
          setError('Не удалось прочитать файл.');
        }
      }} /></label>
      {fileName && <span style={{ color: '#777' }}>{fileName}</span>}
      {error && <div className="sa-card" role="alert" style={{ color: '#991b1b', background: '#fef2f2' }}>{error}</div>}
      {preview && <><p role="status">{preview.valid ? `Проверено: ${preview.total} сотрудников. Все строки готовы к импорту.` : 'Исправьте отмеченные строки в файле и загрузите его снова. До исправления сотрудники не будут созданы.'}</p><div style={{ maxHeight: 350, overflow: 'auto' }}><table className="sa-table"><thead><tr><th>Строка</th><th>Сотрудник</th><th>Email</th><th>Точка</th><th>Проверка</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.fullName}</td><td>{row.email}</td><td>{row.branchName || '—'}</td><td style={{ color: row.errors.length ? '#991b1b' : '#527338' }}>{row.errors.length ? row.errors.join('; ') : 'Готово'}</td></tr>)}</tbody></table></div></>}
    </div>
  </BrutalModal>;
}
