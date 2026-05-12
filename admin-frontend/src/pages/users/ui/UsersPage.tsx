import React, { useEffect, useMemo, useState } from 'react';
import type { AdminRole } from '../../../widgets/admin-sidebar/ui/AdminSidebar';
import {
  changeUserPassword,
  createPermissionTemplate,
  createUser,
  deletePermissionTemplate,
  deleteUser,
  fetchPermissionTemplates,
  fetchRbacMeta,
  fetchUsers,
  updatePermissionTemplate,
  updateUser,
  type PermissionTemplateItem,
  type RbacMeta,
  type UserAccountItem,
} from '../../../shared/api/adminPanel';

type Props = {
  role: AdminRole;
};

type PageTab = 'users' | 'templates';

type MembershipForm = {
  role: string;
  holdingId: string;
  dealershipId: string;
};

type UserFormState = {
  email: string;
  password: string;
  displayName: string;
  status: string;
  memberships: MembershipForm[];
  managerFullName: string;
  managerEmail: string;
  managerPhone: string;
  managerStatus: string;
  templateIds: string[];
};

type TemplateFormState = {
  name: string;
  description: string;
  permissions: string[];
};

const EMPTY_USER_FORM: UserFormState = {
  email: '',
  password: '',
  displayName: '',
  status: 'active',
  memberships: [{ role: 'manager', holdingId: '', dealershipId: '' }],
  managerFullName: '',
  managerEmail: '',
  managerPhone: '',
  managerStatus: 'active',
  templateIds: [],
};

const EMPTY_TEMPLATE_FORM: TemplateFormState = {
  name: '',
  description: '',
  permissions: [],
};

function roleLabel(role: string): string {
  if (role === 'platform_superadmin') return 'Суперадмин';
  if (role === 'holding_admin') return 'Руководитель холдинга';
  if (role === 'dealership_admin') return 'Руководитель автосалона';
  if (role === 'manager') return 'Менеджер';
  return role;
}

function overlayCardStyle(width = 720): React.CSSProperties {
  return {
    width: `min(100%, ${width}px)`,
    maxHeight: '88vh',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: 24,
    boxShadow: '0 28px 80px rgba(15,23,42,0.28)',
    padding: 22,
  };
}

function ModalFrame(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  if (!props.open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.48)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 120,
      }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(props.width)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
            {props.subtitle && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>{props.subtitle}</div>
            )}
          </div>
          <button type="button" className="sa-btn-text" onClick={props.onClose}>
            Закрыть
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function KeyValueList(props: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {props.items.map((item) => (
        <div key={item.label} className="sa-card" style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--sa-text-secondary)', marginBottom: 4 }}>{item.label}</div>
          <div style={{ fontWeight: 600 }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function UsersPage({ role }: Props) {
  const [tab, setTab] = useState<PageTab>('users');
  const [meta, setMeta] = useState<RbacMeta | null>(null);
  const [users, setUsers] = useState<UserAccountItem[]>([]);
  const [templates, setTemplates] = useState<PermissionTemplateItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [viewUserOpen, setViewUserOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [viewTemplateOpen, setViewTemplateOpen] = useState(false);
  const [editTemplateOpen, setEditTemplateOpen] = useState(false);
  const [deleteTemplateOpen, setDeleteTemplateOpen] = useState(false);

  const [userForm, setUserForm] = useState<UserFormState>(EMPTY_USER_FORM);
  const [passwordForm, setPasswordForm] = useState('');
  const [templateForm, setTemplateForm] = useState<TemplateFormState>(EMPTY_TEMPLATE_FORM);
  const [savingUser, setSavingUser] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const canManageTemplates = role === 'super';
  const activeUser = users.find((item) => item.id === activeUserId) ?? null;
  const activeTemplate = templates.find((item) => item.id === activeTemplateId) ?? null;
  const dealershipMap = useMemo(() => new Map((meta?.dealerships || []).map((item) => [item.id, item])), [meta]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [metaData, userData, templateData] = await Promise.all([
          fetchRbacMeta(),
          fetchUsers(),
          canManageTemplates ? fetchPermissionTemplates() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setMeta(metaData);
        setUsers(userData.items);
        setTemplates(templateData);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить данные.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [canManageTemplates]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((item) =>
      [
        item.email,
        item.displayName || '',
        ...item.managerProfiles.map((profile) => profile.fullName),
        ...item.memberships.map((membership) => membership.scopeLabel),
      ].join(' ').toLowerCase().includes(q),
    );
  }, [users, search]);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((item) =>
      [item.name, item.description || '', ...item.permissions].join(' ').toLowerCase().includes(q),
    );
  }, [templates, search]);

  function resetUserForm() {
    setUserForm({
      ...EMPTY_USER_FORM,
      memberships: [{ role: 'manager', holdingId: '', dealershipId: '' }],
    });
  }

  function fillUserForm(user: UserAccountItem) {
    const firstProfile = user.managerProfiles[0];
    setUserForm({
      email: user.email,
      password: '',
      displayName: user.displayName || '',
      status: user.status,
      memberships: user.memberships.length
        ? user.memberships.map((membership) => ({
            role: membership.role,
            holdingId: membership.holdingId || '',
            dealershipId: membership.dealershipId || '',
          }))
        : [{ role: 'manager', holdingId: '', dealershipId: '' }],
      managerFullName: firstProfile?.fullName || '',
      managerEmail: firstProfile?.email || '',
      managerPhone: firstProfile?.phone || '',
      managerStatus: firstProfile?.status || 'active',
      templateIds: user.permissionTemplates.map((template) => template.id),
    });
  }

  function resetTemplateForm() {
    setTemplateForm(EMPTY_TEMPLATE_FORM);
  }

  function fillTemplateForm(template: PermissionTemplateItem) {
    setTemplateForm({
      name: template.name,
      description: template.description || '',
      permissions: template.permissions,
    });
  }

  async function reloadUsers() {
    const data = await fetchUsers();
    setUsers(data.items);
  }

  async function reloadTemplates() {
    if (!canManageTemplates) return;
    setTemplates(await fetchPermissionTemplates());
  }

  function updateMembership(index: number, patch: Partial<MembershipForm>) {
    setUserForm((current) => ({
      ...current,
      memberships: current.memberships.map((membership, membershipIndex) =>
        membershipIndex === index ? { ...membership, ...patch } : membership,
      ),
    }));
  }

  function availableDealerships(membership: MembershipForm) {
    const all = meta?.dealerships || [];
    if (!membership.holdingId) return all;
    return all.filter((item) => item.holdingId === membership.holdingId);
  }

  async function saveUser(mode: 'create' | 'edit') {
    const memberships = (role === 'company'
      ? userForm.memberships.map((membership) => ({ ...membership, role: 'manager' }))
      : userForm.memberships
    ).filter((membership) => membership.role && (membership.holdingId || membership.dealershipId || membership.role === 'platform_superadmin'));

    const managerProfiles = userForm.managerFullName && memberships.some((membership) => membership.role === 'manager')
      ? [{
          fullName: userForm.managerFullName,
          dealershipId: memberships.find((membership) => membership.role === 'manager')?.dealershipId || '',
          email: userForm.managerEmail || null,
          phone: userForm.managerPhone || null,
          status: userForm.managerStatus,
        }]
      : [];

    const payload: Record<string, unknown> = {
      email: userForm.email,
      displayName: userForm.displayName,
      status: userForm.status,
      memberships,
      managerProfiles,
      templateIds: canManageTemplates ? userForm.templateIds : [],
    };
    if (userForm.password.trim()) payload.password = userForm.password;

    if (mode === 'create') {
      return createUser({ ...payload, password: userForm.password });
    }
    if (!activeUserId) throw new Error('Пользователь не выбран.');
    return updateUser(activeUserId, payload);
  }

  async function handleCreateUser(event: React.FormEvent) {
    event.preventDefault();
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveUser('create');
      await reloadUsers();
      if (saved) setActiveUserId(saved.id);
      setCreateUserOpen(false);
      resetUserForm();
      setNotice('Пользователь создан.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать пользователя.');
    } finally {
      setSavingUser(false);
    }
  }

  async function handleEditUser(event: React.FormEvent) {
    event.preventDefault();
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      await saveUser('edit');
      await reloadUsers();
      setEditUserOpen(false);
      setNotice('Пользователь обновлён.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить пользователя.');
    } finally {
      setSavingUser(false);
    }
  }

  async function handleDeleteUserConfirm() {
    if (!activeUserId) return;
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      await deleteUser(activeUserId);
      await reloadUsers();
      setDeleteUserOpen(false);
      setViewUserOpen(false);
      setEditUserOpen(false);
      setActiveUserId(null);
      setNotice('Пользователь удалён.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить пользователя.');
    } finally {
      setSavingUser(false);
    }
  }

  async function handleChangePasswordSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeUserId || !passwordForm) return;
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      await changeUserPassword(activeUserId, passwordForm);
      setPasswordForm('');
      setChangePasswordOpen(false);
      setNotice('Пароль у пользователя успешно изменен');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить пароль пользователя.');
    } finally {
      setSavingUser(false);
    }
  }

  async function handleCreateTemplate(event: React.FormEvent) {
    event.preventDefault();
    setSavingTemplate(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await createPermissionTemplate(templateForm);
      await reloadTemplates();
      setActiveTemplateId(saved.id);
      setCreateTemplateOpen(false);
      resetTemplateForm();
      setNotice('Шаблон прав создан.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать шаблон прав.');
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleEditTemplate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeTemplateId) return;
    setSavingTemplate(true);
    setError(null);
    setNotice(null);
    try {
      await updatePermissionTemplate(activeTemplateId, templateForm);
      await reloadTemplates();
      setEditTemplateOpen(false);
      setNotice('Шаблон прав обновлён.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить шаблон прав.');
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteTemplateConfirm() {
    if (!activeTemplateId) return;
    setSavingTemplate(true);
    setError(null);
    setNotice(null);
    try {
      await deletePermissionTemplate(activeTemplateId);
      await reloadTemplates();
      setDeleteTemplateOpen(false);
      setViewTemplateOpen(false);
      setEditTemplateOpen(false);
      setActiveTemplateId(null);
      setNotice('Шаблон прав удалён.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить шаблон прав.');
    } finally {
      setSavingTemplate(false);
    }
  }

  function renderUserForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string) {
    return (
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
        <label className="sa-form-field">
          <span>Email</span>
          <input className="sa-search-input" value={userForm.email} onChange={(event) => setUserForm((current) => ({ ...current, email: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Пароль</span>
          <input type="password" className="sa-search-input" value={userForm.password} onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Отображаемое имя</span>
          <input className="sa-search-input" value={userForm.displayName} onChange={(event) => setUserForm((current) => ({ ...current, displayName: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Статус</span>
          <select className="sa-select" value={userForm.status} onChange={(event) => setUserForm((current) => ({ ...current, status: event.target.value }))}>
            <option value="active">active</option>
            <option value="invited">invited</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Назначения ролей</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {userForm.memberships.map((membership, index) => {
              const dealerships = availableDealerships(membership);
              const holdingId = membership.holdingId || dealershipMap.get(membership.dealershipId)?.holdingId || '';
              return (
                <div key={`${index}-${membership.role}-${membership.dealershipId}`} className="sa-card" style={{ padding: 12 }}>
                  <div style={{ display: 'grid', gap: 10 }}>
                    <label className="sa-form-field">
                      <span>Роль</span>
                      <select
                        className="sa-select"
                        value={role === 'company' ? 'manager' : membership.role}
                        disabled={role === 'company'}
                        onChange={(event) => updateMembership(index, { role: event.target.value, holdingId: '', dealershipId: '' })}
                      >
                        {role === 'company'
                          ? <option value="manager">manager</option>
                          : (meta?.roles || []).map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </label>
                    {membership.role === 'holding_admin' && (
                      <label className="sa-form-field">
                        <span>Холдинг</span>
                        <select className="sa-select" value={holdingId} onChange={(event) => updateMembership(index, { holdingId: event.target.value, dealershipId: '' })}>
                          <option value="">Выберите холдинг</option>
                          {(meta?.holdings || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>
                    )}
                    {(membership.role === 'dealership_admin' || membership.role === 'manager') && (
                      <>
                        <label className="sa-form-field">
                          <span>Холдинг</span>
                          <select className="sa-select" value={holdingId} onChange={(event) => updateMembership(index, { holdingId: event.target.value, dealershipId: '' })}>
                            <option value="">Выберите холдинг</option>
                            {(meta?.holdings || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select>
                        </label>
                        <label className="sa-form-field">
                          <span>Автосалон</span>
                          <select className="sa-select" value={membership.dealershipId} onChange={(event) => updateMembership(index, { dealershipId: event.target.value, holdingId: dealershipMap.get(event.target.value)?.holdingId || holdingId })}>
                            <option value="">Выберите автосалон</option>
                            {dealerships.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.holdingName || 'Без холдинга'}</option>)}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {role === 'super' && (
            <button type="button" className="sa-btn-text" style={{ marginTop: 10 }} onClick={() => setUserForm((current) => ({ ...current, memberships: [...current.memberships, { role: 'manager', holdingId: '', dealershipId: '' }] }))}>
              + Добавить ещё назначение
            </button>
          )}
        </div>
        <div className="sa-card" style={{ padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Профиль менеджера</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <label className="sa-form-field">
              <span>ФИО менеджера</span>
              <input className="sa-search-input" value={userForm.managerFullName} onChange={(event) => setUserForm((current) => ({ ...current, managerFullName: event.target.value }))} />
            </label>
            <label className="sa-form-field">
              <span>Email профиля</span>
              <input className="sa-search-input" value={userForm.managerEmail} onChange={(event) => setUserForm((current) => ({ ...current, managerEmail: event.target.value }))} />
            </label>
            <label className="sa-form-field">
              <span>Телефон</span>
              <input className="sa-search-input" value={userForm.managerPhone} onChange={(event) => setUserForm((current) => ({ ...current, managerPhone: event.target.value }))} />
            </label>
          </div>
        </div>
        {canManageTemplates && (
          <div className="sa-card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Шаблоны прав</div>
            <div style={{ display: 'grid', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
              {templates.map((template) => (
                <label key={template.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={userForm.templateIds.includes(template.id)}
                    onChange={() =>
                      setUserForm((current) => ({
                        ...current,
                        templateIds: current.templateIds.includes(template.id)
                          ? current.templateIds.filter((item) => item !== template.id)
                          : [...current.templateIds, template.id],
                      }))
                    }
                  />
                  <span>
                    <strong>{template.name}</strong>
                    <br />
                    <span style={{ color: 'var(--sa-text-secondary)', fontSize: 12 }}>{template.permissions.slice(0, 4).join(', ')}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        <button type="submit" className="sa-btn-danger" disabled={savingUser}>
          {savingUser ? 'Сохраняем...' : submitLabel}
        </button>
      </form>
    );
  }

  function renderTemplateForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string) {
    return (
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <label className="sa-form-field">
          <span>Название шаблона</span>
          <input className="sa-search-input" value={templateForm.name} onChange={(event) => setTemplateForm((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Описание</span>
          <textarea className="sa-search-input" rows={3} value={templateForm.description} onChange={(event) => setTemplateForm((current) => ({ ...current, description: event.target.value }))} />
        </label>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Permissions</div>
          <div style={{ display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {(meta?.permissions || []).map((permission) => (
              <label key={permission.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={templateForm.permissions.includes(permission.key)}
                  onChange={() =>
                    setTemplateForm((current) => ({
                      ...current,
                      permissions: current.permissions.includes(permission.key)
                        ? current.permissions.filter((item) => item !== permission.key)
                        : [...current.permissions, permission.key],
                    }))
                  }
                />
                <span>
                  <strong>{permission.key}</strong>
                  <br />
                  <span style={{ color: 'var(--sa-text-secondary)', fontSize: 12 }}>{permission.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <button type="submit" className="sa-btn-danger" disabled={savingTemplate}>
          {savingTemplate ? 'Сохраняем...' : submitLabel}
        </button>
      </form>
    );
  }

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    border: 'none',
    borderBottom: active ? '2px solid #F59E0B' : '2px solid transparent',
    background: 'transparent',
    padding: '0 0 14px',
    fontSize: 15,
    fontWeight: 700,
    color: active ? '#111827' : 'var(--sa-text-secondary)',
    cursor: 'pointer',
  });

  return (
    <div>
      <h1 className="sa-page-title">Пользователи</h1>
      <p className="sa-page-subtitle">
        {role === 'super'
          ? 'Суперадмин управляет аккаунтами и шаблонами прав.'
          : 'Руководитель холдинга управляет менеджерами своих автосалонов.'}
      </p>

      {error && <div className="sa-card" style={{ marginBottom: 16, color: '#991B1B', background: '#FEF2F2' }}>{error}</div>}
      {notice && <div className="sa-card" style={{ marginBottom: 16, color: '#166534', background: '#F0FDF4' }}>{notice}</div>}

      <div className="sa-card" style={{ padding: '0 20px', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', paddingTop: 18 }}>
          <button type="button" style={tabButtonStyle(tab === 'users')} onClick={() => setTab('users')}>
            Списки пользователей
          </button>
          {canManageTemplates && (
            <button type="button" style={tabButtonStyle(tab === 'templates')} onClick={() => setTab('templates')}>
              Шаблоны прав
            </button>
          )}
        </div>
      </div>

      {tab === 'users' && (
        <section className="sa-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 22 }}>Список пользователей</h2>
              <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)', marginTop: 6 }}>
                {loading ? 'Загрузка...' : `${filteredUsers.length} аккаунтов`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                className="sa-search-input"
                style={{ width: 320 }}
                placeholder="Поиск по email, имени, scope"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="button"
                className="sa-btn-danger"
                onClick={() => {
                  resetUserForm();
                  setCreateUserOpen(true);
                }}
              >
                Новый пользователь
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {filteredUsers.map((item) => (
              <div key={item.id} className="sa-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{item.displayName || item.managerProfiles[0]?.fullName || item.email}</div>
                    <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>{item.email}</div>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {item.memberships.map((membership) => (
                        <span key={membership.id} className="sa-metric-chip">
                          {roleLabel(membership.role)} · {membership.scopeLabel}
                        </span>
                      ))}
                      {item.permissionTemplates.map((template) => (
                        <span key={template.id} className="sa-metric-chip">{template.name}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
                    <span className={`sa-state-chip ${item.status === 'active' ? 'sa-state-good' : 'sa-state-risk'}`}>{item.status}</span>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button type="button" className="sa-btn-outline" onClick={() => { setActiveUserId(item.id); setViewUserOpen(true); }}>
                        Просмотр
                      </button>
                      <button type="button" className="sa-btn-outline" onClick={() => { setActiveUserId(item.id); fillUserForm(item); setEditUserOpen(true); }}>
                        Редактировать
                      </button>
                      <button type="button" className="sa-btn-outline" onClick={() => { setActiveUserId(item.id); setPasswordForm(''); setChangePasswordOpen(true); }}>
                        Сменить пароль
                      </button>
                      <button type="button" className="sa-btn-danger" onClick={() => { setActiveUserId(item.id); setDeleteUserOpen(true); }}>
                        Удалить
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'templates' && canManageTemplates && (
        <section className="sa-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 22 }}>Список шаблонов прав</h2>
              <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)', marginTop: 6 }}>
                {loading ? 'Загрузка...' : `${filteredTemplates.length} шаблонов`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                className="sa-search-input"
                style={{ width: 320 }}
                placeholder="Поиск по названию и permission"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" className="sa-btn-danger" onClick={() => { resetTemplateForm(); setCreateTemplateOpen(true); }}>
                Новый шаблон
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {filteredTemplates.map((template) => (
              <div key={template.id} className="sa-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{template.name}</div>
                    <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>{template.description || 'Без описания'}</div>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <span className="sa-metric-chip">{template.assignedAccountsCount} назначений</span>
                      {template.permissions.slice(0, 6).map((permission) => (
                        <span key={permission} className="sa-metric-chip">{permission}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
                    <button type="button" className="sa-btn-outline" onClick={() => { setActiveTemplateId(template.id); setViewTemplateOpen(true); }}>
                      Просмотр
                    </button>
                    <button type="button" className="sa-btn-outline" onClick={() => { setActiveTemplateId(template.id); fillTemplateForm(template); setEditTemplateOpen(true); }}>
                      Редактировать
                    </button>
                    <button type="button" className="sa-btn-danger" onClick={() => { setActiveTemplateId(template.id); setDeleteTemplateOpen(true); }}>
                      Удалить
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ModalFrame
        title="Новый пользователь"
        subtitle="Создание аккаунта вынесено в отдельное модальное окно."
        open={createUserOpen}
        onClose={() => setCreateUserOpen(false)}
      >
        {renderUserForm(handleCreateUser, 'Создать пользователя')}
      </ModalFrame>

      <ModalFrame
        title="Просмотр пользователя"
        subtitle="Детальная карточка пользователя без режима редактирования."
        open={viewUserOpen && !!activeUser}
        onClose={() => setViewUserOpen(false)}
        width={760}
      >
        {activeUser && (
          <div style={{ display: 'grid', gap: 16 }}>
            <KeyValueList
              items={[
                { label: 'Email', value: activeUser.email },
                { label: 'Имя', value: activeUser.displayName || '—' },
                { label: 'Статус', value: activeUser.status },
                { label: 'Последний вход', value: activeUser.lastLoginAt ? new Date(activeUser.lastLoginAt).toLocaleString('ru-RU') : '—' },
              ]}
            />
            <div className="sa-card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Роли и scope</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeUser.memberships.map((membership) => (
                  <span key={membership.id} className="sa-metric-chip">{roleLabel(membership.role)} · {membership.scopeLabel}</span>
                ))}
              </div>
            </div>
            <div className="sa-card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Профили менеджера</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {activeUser.managerProfiles.length ? activeUser.managerProfiles.map((profile) => (
                  <div key={profile.id}>{profile.fullName} · {profile.dealershipName} · {profile.holdingName || 'Без холдинга'}</div>
                )) : <div>Нет профилей менеджера</div>}
              </div>
            </div>
            {!!activeUser.permissionTemplates.length && (
              <div className="sa-card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Шаблоны прав</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {activeUser.permissionTemplates.map((template) => (
                    <span key={template.id} className="sa-metric-chip">{template.name}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        title="Редактировать пользователя"
        subtitle="Изменение пользователя выполняется через отдельное модальное окно."
        open={editUserOpen}
        onClose={() => setEditUserOpen(false)}
      >
        {renderUserForm(handleEditUser, 'Сохранить пользователя')}
      </ModalFrame>

      <ModalFrame
        title="Удалить пользователя"
        subtitle="Удаление необратимо."
        open={deleteUserOpen && !!activeUser}
        onClose={() => setDeleteUserOpen(false)}
        width={520}
      >
        {activeUser && (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0 }}>
              Удалить пользователя <strong>{activeUser.displayName || activeUser.email}</strong>?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="sa-btn-outline" onClick={() => setDeleteUserOpen(false)}>Отмена</button>
              <button type="button" className="sa-btn-danger" onClick={handleDeleteUserConfirm} disabled={savingUser}>
                {savingUser ? 'Удаляем...' : 'Удалить'}
              </button>
            </div>
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        title="Сменить пароль"
        subtitle={activeUser ? `Пользователь: ${activeUser.displayName || activeUser.email}` : undefined}
        open={changePasswordOpen && !!activeUser}
        onClose={() => setChangePasswordOpen(false)}
        width={520}
      >
        {activeUser && (
          <form onSubmit={handleChangePasswordSubmit} style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Новый пароль</span>
              <input
                type="password"
                className="sa-input"
                value={passwordForm}
                onChange={(event) => setPasswordForm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="sa-btn-outline" onClick={() => setChangePasswordOpen(false)}>Отмена</button>
              <button type="submit" className="sa-btn-primary" disabled={savingUser || !passwordForm}>
                {savingUser ? 'Сохраняем...' : 'Сменить пароль'}
              </button>
            </div>
          </form>
        )}
      </ModalFrame>

      <ModalFrame
        title="Новый шаблон прав"
        subtitle="Создание шаблона прав вынесено в отдельное модальное окно."
        open={createTemplateOpen}
        onClose={() => setCreateTemplateOpen(false)}
      >
        {renderTemplateForm(handleCreateTemplate, 'Создать шаблон')}
      </ModalFrame>

      <ModalFrame
        title="Просмотр шаблона прав"
        subtitle="Полный список permission для шаблона."
        open={viewTemplateOpen && !!activeTemplate}
        onClose={() => setViewTemplateOpen(false)}
        width={760}
      >
        {activeTemplate && (
          <div style={{ display: 'grid', gap: 16 }}>
            <KeyValueList
              items={[
                { label: 'Название', value: activeTemplate.name },
                { label: 'Описание', value: activeTemplate.description || '—' },
                { label: 'Назначений', value: activeTemplate.assignedAccountsCount },
              ]}
            />
            <div className="sa-card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Permissions</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeTemplate.permissions.map((permission) => (
                  <span key={permission} className="sa-metric-chip">{permission}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        title="Редактировать шаблон прав"
        subtitle="Изменение шаблона выполняется через отдельное модальное окно."
        open={editTemplateOpen}
        onClose={() => setEditTemplateOpen(false)}
      >
        {renderTemplateForm(handleEditTemplate, 'Сохранить шаблон')}
      </ModalFrame>

      <ModalFrame
        title="Удалить шаблон прав"
        subtitle="Шаблон будет удалён вместе с его назначениями."
        open={deleteTemplateOpen && !!activeTemplate}
        onClose={() => setDeleteTemplateOpen(false)}
        width={520}
      >
        {activeTemplate && (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0 }}>
              Удалить шаблон <strong>{activeTemplate.name}</strong>?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="sa-btn-outline" onClick={() => setDeleteTemplateOpen(false)}>Отмена</button>
              <button type="button" className="sa-btn-danger" onClick={handleDeleteTemplateConfirm} disabled={savingTemplate}>
                {savingTemplate ? 'Удаляем...' : 'Удалить'}
              </button>
            </div>
          </div>
        )}
      </ModalFrame>
    </div>
  );
}
