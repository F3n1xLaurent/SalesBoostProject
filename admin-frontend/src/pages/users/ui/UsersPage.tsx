import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EmployeeDetail } from '../../employee-detail/ui/EmployeeDetailPage';
import type { AdminRole } from '../../../widgets/admin-sidebar/ui/AdminSidebar';
import {
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
import { deltaDisplay, ratingClass, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import { UserPhoneNumbersModal } from '../../../shared/ui/dealership-phone-numbers/DealershipPhoneNumbersModal';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { EditIcon, PhoneIcon } from '../../../shared/ui/icons/ActionIcons';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { UnsavedChangesModal } from '../../../shared/ui/unsaved-changes-modal';
import { DeleteConfirmModal } from '../../../shared/ui/delete-confirm-modal';
import { FiltersPanel, FilterGroup, FiltersToggleButton } from '../../../shared/ui/filters-panel';

const TEMPLATE_FORM_ID = 'permission-template-form';

type Props = {
  role: AdminRole;
  employeeId?: string | null;
  onSelectEmployee?: (id: string) => void;
  onBackToUsers?: () => void;
  onOpenDealership?: (id: string) => void;
  onOpenCompanies?: () => void;
  sourceDealership?: { id: string; name: string } | null;
};

type PageTab = 'users' | 'templates';
type UserSortKey = 'fullName' | 'dealershipName' | 'aiRating' | 'deltaRating' | 'auditsCount' | 'failsCount' | 'status';
type SortDir = 'asc' | 'desc';

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

type PermissionDefinition = RbacMeta['permissions'][number];
type SelectOption = {
  value: string;
  label: string;
  description?: string;
};
type UserOwnershipFilter = 'all' | 'own' | 'franchised';
type UserEmployeeRow = {
  user: UserAccountItem;
  fullName: string;
  dealershipName: string;
  dealershipNames: string[];
  city: string;
};

const NO_HOLDING_VALUE = '__no_holding__';

const USER_COLUMN_DEFS: { key: UserSortKey; label: string; align?: 'right' }[] = [
  { key: 'fullName', label: 'Сотрудник' },
  { key: 'dealershipName', label: 'Точки' },
  { key: 'aiRating', label: 'AI-рейтинг', align: 'right' },
  { key: 'deltaRating', label: 'Динамика', align: 'right' },
  { key: 'auditsCount', label: 'Проверки', align: 'right' },
  { key: 'failsCount', label: 'Провалы', align: 'right' },
];

const USER_ANALYTICS_STATUS_LABELS: Record<UserAccountItem['analytics']['status'], string> = {
  norm: 'Норма',
  risk: 'Риск',
  critical: 'Критично',
  'no-data': 'Нет данных',
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

const CREATE_USER_FORM_ID = 'create-user-modal-form';
const EDIT_USER_FORM_ID = 'edit-user-modal-form';

function normalizeUserForm(form: UserFormState) {
  return {
    email: form.email.trim(),
    password: form.password,
    managerFullName: (form.managerFullName || form.displayName).trim(),
    status: form.status,
    memberships: form.memberships.map((membership) => ({
      role: membership.role,
      holdingId: membership.holdingId,
      dealershipId: membership.dealershipId,
    })),
    templateIds: [...form.templateIds].sort(),
  };
}

const EMPTY_TEMPLATE_FORM: TemplateFormState = {
  name: '',
  description: '',
  permissions: [],
};

const PERMISSION_GROUPS = [
  {
    id: 'dashboards',
    title: 'Дашборды и аналитика',
    description: 'Главные экраны, сводки, графики и аналитические отчеты.',
    match: (key: string) => key.startsWith('dashboard.') || key.startsWith('analytics.') || key.startsWith('ux.analytics.'),
  },
  {
    id: 'organization',
    title: 'Оргструктура',
    description: 'Компании, точки, карточки точек и типы номеров.',
    match: (key: string) => key.startsWith('holding.') || key.startsWith('dealer.') || key.startsWith('ux.holdings.') || key.startsWith('ux.dealerships.') || key.startsWith('ux.phone_number_types.'),
  },
  {
    id: 'people',
    title: 'Сотрудники',
    description: 'Web-аккаунты, менеджеры, роли и карточки сотрудников.',
    match: (key: string) => key.startsWith('user.') || key.startsWith('manager.') || key.startsWith('ux.users.') || key.startsWith('ux.employees.'),
  },
  {
    id: 'permissions',
    title: 'Шаблоны прав',
    description: 'Создание, назначение и администрирование наборов прав.',
    match: (key: string) => key.startsWith('permission_template.') || key.startsWith('ux.permission_templates.'),
  },
  {
    id: 'audits',
    title: 'Проверки и разборы',
    description: 'Аудиты, batch-проверки, детальные разборы и экспорт.',
    match: (key: string) => key.startsWith('audit.') || key.startsWith('call_batch.') || key.startsWith('ux.audits.'),
  },
  {
    id: 'calls',
    title: 'Звонки и телефония',
    description: 'История звонков, запуск звонков и диагностика voice-инфраструктуры.',
    match: (key: string) => key.startsWith('call.') || key.startsWith('voice.'),
  },
  {
    id: 'workspaces',
    title: 'Рабочие кабинеты',
    description: 'Разделы точки и личный кабинет менеджера.',
    match: (key: string) => key.startsWith('ux.dealership_workspace.') || key.startsWith('ux.staff_workspace.') || key.startsWith('profile.') || key.startsWith('training.'),
  },
  {
    id: 'settings',
    title: 'Настройки и финансы',
    description: 'Настройки аккаунта, платформы, расходы и финансовые выгрузки.',
    match: (key: string) => key.startsWith('settings.') || key.startsWith('expenses.'),
  },
] as const;

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard.view': 'Общий дашборд',
  'dashboard.platform.view': 'Дашборд платформы',
  'dashboard.holding.view': 'Дашборд компании',
  'dashboard.dealership.view': 'Дашборд точки',
  'analytics.view': 'Просмотр аналитики',
  'analytics.export': 'Экспорт аналитики',
  'holding.view': 'Просмотр компаний',
  'holding.edit': 'Редактирование компаний',
  'dealer.view': 'Просмотр точек',
  'dealer.edit': 'Редактирование точек',
  'manager.view': 'Просмотр сотрудников',
  'manager.edit': 'Редактирование сотрудников',
  'user.view': 'Просмотр web-аккаунтов',
  'user.create': 'Создание сотрудников',
  'user.edit': 'Редактирование сотрудников',
  'user.delete': 'Удаление сотрудников',
  'permission_template.view': 'Просмотр шаблонов прав',
  'permission_template.create': 'Создание шаблонов прав',
  'permission_template.edit': 'Редактирование шаблонов прав',
  'permission_template.assign': 'Назначение шаблонов сотрудникам',
  'permission_template.delete': 'Удаление шаблонов прав',
  'audit.view': 'Просмотр проверок',
  'audit.export': 'Экспорт проверок',
  'audit.run': 'Запуск проверок',
  'audit.manage': 'Управление проверками',
  'call.view': 'Просмотр звонков',
  'call.start': 'Запуск звонков',
  'call_batch.view': 'Просмотр batch-звонков',
  'call_batch.create': 'Создание batch-звонков',
  'call_batch.manage': 'Управление batch-звонками',
  'training.view': 'Просмотр тренировок',
  'training.run': 'Запуск тренажера',
  'training.review': 'Просмотр результатов тренировок',
  'profile.view': 'Просмотр своего профиля',
  'profile.edit': 'Редактирование своего профиля',
  'settings.view': 'Просмотр настроек',
  'settings.edit': 'Редактирование системных настроек',
  'settings.platform.view': 'Настройки платформы',
  'settings.holding.view': 'Настройки компании',
  'settings.dealership.view': 'Настройки точки',
  'settings.manager.view': 'Настройки менеджера',
  'expenses.view': 'Просмотр расходов',
  'expenses.export': 'Экспорт расходов',
  'voice.diagnostics': 'Диагностика телефонии',
  'ux.holdings.view': 'Страница “Компании”',
  'ux.dealerships.list': 'Список точек',
  'ux.dealerships.detail': 'Карточка точки',
  'ux.phone_number_types.view': 'Страница “Типы номеров”',
  'ux.users.view': 'Страница “Сотрудники”',
  'ux.employees.list': 'Список сотрудников',
  'ux.employees.detail': 'Карточка сотрудника',
  'ux.audits.employees.view': 'Проверки по сотрудникам',
  'ux.audits.dealerships.view': 'Проверки по точкам',
  'ux.audits.detail': 'Детальный разбор проверки',
  'ux.audits.batches.view': 'Batch-проверки',
  'ux.analytics.platform.view': 'Аналитика платформы',
  'ux.analytics.holding.view': 'Аналитика компании',
  'ux.analytics.dealership_team.view': 'Аналитика команды точки',
  'ux.dealership_workspace.overview': 'Кабинет точки: обзор',
  'ux.dealership_workspace.calls': 'Кабинет точки: звонки',
  'ux.dealership_workspace.employees': 'Кабинет точки: сотрудники',
  'ux.dealership_workspace.team': 'Кабинет точки: команда',
  'ux.staff_workspace.profile': 'Кабинет менеджера: профиль',
  'ux.staff_workspace.trainer': 'Кабинет менеджера: тренажер',
  'ux.permission_templates.view': 'Вкладка “Шаблоны прав”',
};

function permissionLabel(key: string): string {
  return PERMISSION_LABELS[key] || key;
}

function permissionGroupFor(key: string) {
  return PERMISSION_GROUPS.find((group) => group.match(key)) || {
    id: 'other',
    title: 'Прочее',
    description: 'Служебные права, которые не попали в основные разделы.',
    match: () => false,
  };
}

function roleLabel(role: string): string {
  if (role === 'platform_superadmin') return 'Суперадмин';
  if (role === 'holding_admin') return 'Руководитель компании';
  if (role === 'dealership_admin') return 'Руководитель точки';
  if (role === 'manager') return 'Менеджер';
  return role;
}

function roleDescription(role: string): string {
  if (role === 'platform_superadmin') return 'Полный доступ ко всей платформе';
  if (role === 'holding_admin') return 'Управляет выбранной компанией';
  if (role === 'dealership_admin') return 'Управляет выбранным точкой';
  if (role === 'manager') return 'Работает в кабинете менеджера';
  return '';
}

function defaultTemplateNameForRole(role: string): string | null {
  if (role === 'platform_superadmin') return 'Суперадмин платформы';
  if (role === 'holding_admin') return 'Администратор холдинга';
  if (role === 'dealership_admin') return 'Администратор автосалона';
  if (role === 'manager') return 'Менеджер автосалона';
  return null;
}

function statusLabel(status: string): string {
  if (status === 'active') return 'Аккаунт включен';
  if (status === 'invited') return 'Приглашение отправлено';
  if (status === 'disabled') return 'Аккаунт выключен';
  return status;
}

function userFullName(user: UserAccountItem): string {
  return user.displayName || user.managerProfiles[0]?.fullName || user.email;
}

function userScopeLabel(user: UserAccountItem): string {
  const dealershipMembership = user.memberships.find((membership) => membership.dealershipId);
  return dealershipMembership?.scopeLabel || user.memberships[0]?.scopeLabel || 'Точка не указана';
}

function userDealershipNames(user: UserAccountItem): string[] {
  const names = [
    ...user.memberships.map((membership) => membership.dealershipName || ''),
    ...user.managerProfiles.map((profile) => profile.dealershipName),
  ].map((name) => name.trim()).filter(Boolean);
  return [...new Set(names)];
}

function normalizeSearchValue(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

function normalizePhoneValue(value: string): string {
  return value.replace(/\D/g, '');
}

function userPhoneHaystack(user: UserAccountItem): string {
  return [
    ...(user.phoneNumbers || []).map((item) => item.phone),
    ...user.managerProfiles.map((profile) => profile.phone || ''),
  ].map(normalizePhoneValue).join(' ');
}

function userMatchesScope(user: UserAccountItem, scopeFilter: string): boolean {
  if (!scopeFilter) return true;
  const [scopeType, scopeId] = scopeFilter.split(':');
  if (!scopeType || !scopeId) return true;

  if (scopeType === 'holding') {
    return user.memberships.some((membership) => membership.holdingId === scopeId)
      || user.managerProfiles.some((profile) => profile.holdingId === scopeId);
  }

  if (scopeType === 'dealership') {
    return user.memberships.some((membership) => membership.dealershipId === scopeId)
      || user.managerProfiles.some((profile) => profile.dealershipId === scopeId);
  }

  return true;
}

function userMatchesOwnership(user: UserAccountItem, ownership: UserOwnershipFilter): boolean {
  if (ownership === 'all') return true;
  return [
    ...user.memberships.map((membership) => membership.dealershipType),
    ...user.managerProfiles.map((profile) => profile.dealershipType),
  ].some((type) => type === ownership);
}

function SearchableSelect(props: {
  label?: string;
  value: string;
  options: SelectOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((option) => option.value === props.value) || null;
  const filtered = props.options.filter((option) => {
    const haystack = [option.label, option.description || ''].join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (dropdownRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const updateRect = () => {
      if (!rootRef.current) return;
      setDropdownRect(rootRef.current.getBoundingClientRect());
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`sa-searchable-select${open ? ' sa-searchable-select--open' : ''}${props.disabled ? ' is-disabled' : ''}`}>
      {props.label && <div className="sa-searchable-select__label">{props.label}</div>}
      <button
        type="button"
        className="sa-searchable-select__trigger"
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!props.disabled) setOpen((current) => !current);
        }}
      >
        <span className="sa-searchable-select__value">
          <span className="sa-searchable-select__value-label">{selected?.label || props.placeholder}</span>
          {selected?.description && (
            <span className="sa-searchable-select__value-desc">{selected.description}</span>
          )}
        </span>
        <span className="sa-searchable-select__chevron" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && !props.disabled && dropdownRect && createPortal(
        <div
          className="theme-brutal"
          style={{
            position: 'fixed',
            zIndex: 1600,
            top: dropdownRect.bottom + 6,
            left: dropdownRect.left,
            width: Math.max(dropdownRect.width, 240),
          }}
        >
          <div ref={dropdownRef} className="sa-searchable-select__menu">
            <input
              className="sa-input sa-searchable-select__search"
              value={query}
              autoFocus
              placeholder="Поиск..."
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="sa-searchable-select__options" role="listbox">
              {props.value && (
                <button
                  type="button"
                  className="sa-tag-filter-option"
                  onClick={() => {
                    props.onChange('');
                    setQuery('');
                    setOpen(false);
                  }}
                >
                  <span className="sa-tag-filter-option__label">{props.placeholder}</span>
                </button>
              )}
              {filtered.length === 0 && (
                <div className="sa-searchable-select__empty">Ничего не найдено</div>
              )}
              {filtered.map((option) => {
                const isSelected = option.value === props.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`sa-tag-filter-option${isSelected ? ' sa-tag-filter-option--selected' : ''}`}
                    onClick={() => {
                      props.onChange(option.value);
                      setQuery('');
                      setOpen(false);
                    }}
                  >
                    <span className="sa-tag-filter-option__label">{option.label}</span>
                    {option.description && (
                      <span className="sa-searchable-select__option-desc">{option.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ModalFrame(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <BrutalModal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      subtitle={props.subtitle}
      width={props.width ?? 'medium'}
      headerActions={props.headerActions}
      footer={props.footer}
    >
      {props.children}
    </BrutalModal>
  );
}

function CreateUserModal(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (form: UserFormState) => Promise<void>;
  meta: RbacMeta | null;
  templates: PermissionTemplateItem[];
  canManageTemplates: boolean;
  canManageGlobalUsers: boolean;
  saving: boolean;
}) {
  const [form, setForm] = useState<UserFormState>(EMPTY_USER_FORM);
  const [attempted, setAttempted] = useState(false);
  const dealershipMap = useMemo(() => new Map((props.meta?.dealerships || []).map((item) => [item.id, item])), [props.meta]);
  const emailInvalid = attempted && !form.email.trim();
  const passwordInvalid = attempted && !form.password.trim();
  const nameInvalid = attempted && !form.managerFullName.trim();

  useEffect(() => {
    if (!props.open) return;
    setAttempted(false);
    setForm({
      ...EMPTY_USER_FORM,
      memberships: [{ role: 'manager', holdingId: '', dealershipId: '' }],
    });
  }, [props.open]);

  function suggestedTemplateIdForRole(nextRole: string): string {
    const templateName = defaultTemplateNameForRole(nextRole);
    if (!templateName) return '';
    return props.templates.find((template) => template.name === templateName)?.id || '';
  }

  useEffect(() => {
    if (!props.open || !props.canManageTemplates) return;
    const firstRole = props.canManageGlobalUsers ? form.memberships[0]?.role : 'manager';
    const templateId = suggestedTemplateIdForRole(firstRole || 'manager');
    setForm((current) => {
      const nextTemplateIds = templateId ? [templateId] : [];
      if (current.templateIds[0] === nextTemplateIds[0] && current.templateIds.length === nextTemplateIds.length) return current;
      return { ...current, templateIds: nextTemplateIds };
    });
  }, [props.canManageGlobalUsers, props.canManageTemplates, props.open, props.templates, form.memberships]);

  function updateMembership(index: number, patch: Partial<MembershipForm>) {
    setForm((current) => ({
      ...current,
      memberships: current.memberships.map((membership, membershipIndex) =>
        membershipIndex === index ? { ...membership, ...patch } : membership,
      ),
    }));
  }

  function updateMembershipRole(index: number, nextRole: string) {
    const templateId = suggestedTemplateIdForRole(nextRole);
    setForm((current) => ({
      ...current,
      memberships: current.memberships.map((membership, membershipIndex) =>
        membershipIndex === index ? { ...membership, role: nextRole, holdingId: '', dealershipId: '' } : membership,
      ),
      templateIds: props.canManageTemplates && templateId ? [templateId] : current.templateIds,
    }));
  }

  function availableDealerships(membership: MembershipForm) {
    const all = props.meta?.dealerships || [];
    if (membership.holdingId === NO_HOLDING_VALUE) return all.filter((item) => !item.holdingId);
    if (!membership.holdingId) return [];
    return all.filter((item) => item.holdingId === membership.holdingId);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!form.email.trim() || !form.password.trim() || !form.managerFullName.trim()) return;
    await props.onSubmit(form);
  }

  return (
    <ModalFrame
      title="Новый сотрудник"
      subtitle="Создание аккаунта вынесено в отдельное модальное окно."
      open={props.open}
      onClose={props.onClose}
      footer={(
        <div className="sa-modal-footer-row">
          <div className="sa-modal-footer-row__right">
            <button type="button" className="sa-btn-outline" onClick={props.onClose} disabled={props.saving}>
              Отмена
            </button>
            <button type="submit" form={CREATE_USER_FORM_ID} className="sa-btn-primary" disabled={props.saving}>
              {props.saving ? 'Сохраняем...' : 'Создать сотрудника'}
            </button>
          </div>
        </div>
      )}
    >
      <form id={CREATE_USER_FORM_ID} onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
        <label className="sa-form-field">
          <span>Email</span>
          <input
            className={`sa-search-input${emailInvalid ? ' sa-field-invalid' : ''}`}
            value={form.email}
            onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
            aria-invalid={emailInvalid || undefined}
          />
        </label>
        <label className="sa-form-field">
          <span>Пароль</span>
          <input
            type="password"
            className={`sa-search-input${passwordInvalid ? ' sa-field-invalid' : ''}`}
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            aria-invalid={passwordInvalid || undefined}
          />
        </label>
        <label className="sa-form-field">
          <span>ФИО</span>
          <input
            className={`sa-search-input${nameInvalid ? ' sa-field-invalid' : ''}`}
            value={form.managerFullName}
            onChange={(event) => setForm((current) => ({ ...current, managerFullName: event.target.value, displayName: event.target.value }))}
            aria-invalid={nameInvalid || undefined}
          />
        </label>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Доступ сотрудника</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {form.memberships.map((membership, index) => {
              const dealerships = availableDealerships(membership);
              const holdingId = membership.holdingId || dealershipMap.get(membership.dealershipId)?.holdingId || '';
              const roleOptions = !props.canManageGlobalUsers
                ? [{ value: 'manager', label: roleLabel('manager'), description: roleDescription('manager') }]
                : (props.meta?.roles || []).map((item) => ({ value: item, label: roleLabel(item), description: roleDescription(item) }));
              const holdingOptions = [
                ...(membership.role === 'dealership_admin' || membership.role === 'manager'
                  ? [{ value: NO_HOLDING_VALUE, label: 'Без компании', description: 'Показать точки без привязки к компании' }]
                  : []),
                ...(props.meta?.holdings || []).map((item) => ({ value: item.id, label: item.name })),
              ];
              const dealershipOptions = dealerships.map((item) => ({
                value: item.id,
                label: item.name,
                description: item.holdingName || 'Без компании',
              }));
              return (
                <div key={`${index}-${membership.role}-${membership.dealershipId}`} style={{ display: 'grid', gap: 10 }}>
                  <SearchableSelect
                    label="Права"
                    value={props.canManageGlobalUsers ? membership.role : 'manager'}
                    disabled={!props.canManageGlobalUsers}
                    options={roleOptions}
                    placeholder="Выберите права сотрудника"
                    onChange={(value) => updateMembershipRole(index, value)}
                  />
                  {membership.role === 'holding_admin' && (
                    <SearchableSelect
                      label="Компания"
                      value={holdingId}
                      options={(props.meta?.holdings || []).map((item) => ({ value: item.id, label: item.name }))}
                      placeholder="Выберите компанию"
                      onChange={(value) => updateMembership(index, { holdingId: value, dealershipId: '' })}
                    />
                  )}
                  {(membership.role === 'dealership_admin' || membership.role === 'manager') && (
                    <>
                      <SearchableSelect
                        label="Компания"
                        value={holdingId}
                        options={holdingOptions}
                        placeholder="Выберите компанию"
                        onChange={(value) => updateMembership(index, { holdingId: value, dealershipId: '' })}
                      />
                      <SearchableSelect
                        label="Точка"
                        value={membership.dealershipId}
                        options={dealershipOptions}
                        placeholder={holdingId ? 'Выберите точку' : 'Сначала выберите компанию'}
                        onChange={(value) => {
                          const selectedDealership = dealershipMap.get(value);
                          updateMembership(index, {
                            dealershipId: value,
                            holdingId: selectedDealership?.holdingId || NO_HOLDING_VALUE,
                          });
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </form>
    </ModalFrame>
  );
}

function KeyValueList(props: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {props.items.map((item) => (
        <div key={item.label} className="sa-bordered-block">
          <div className="sa-meta" style={{ marginBottom: 4 }}>{item.label}</div>
          <div style={{ fontWeight: 600 }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function UsersPage({ role, employeeId, onSelectEmployee, onBackToUsers, onOpenDealership, onOpenCompanies, sourceDealership }: Props) {
  const [tab, setTab] = useState<PageTab>('users');
  const [meta, setMeta] = useState<RbacMeta | null>(null);
  const [users, setUsers] = useState<UserAccountItem[]>([]);
  const [templates, setTemplates] = useState<PermissionTemplateItem[]>([]);
  const [search, setSearch] = useState('');
  const [fullNameFilter, setFullNameFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState<string[]>([]);
  const [holdingFilter, setHoldingFilter] = useState('');
  const [dealershipFilter, setDealershipFilter] = useState('');
  const [ownershipFilter, setOwnershipFilter] = useState<UserOwnershipFilter>('all');
  const [userSortKey, setUserSortKey] = useState<UserSortKey>('aiRating');
  const [userSortDir, setUserSortDir] = useState<SortDir>('desc');
  const [showUserFilters, setShowUserFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedGlobalHoldingId, setSelectedGlobalHoldingId] = useGlobalHoldingFilter(meta?.holdings || [], !loading);

  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [viewUserOpen, setViewUserOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editDeleteConfirm, setEditDeleteConfirm] = useState(false);
  const [userUnsavedOpen, setUserUnsavedOpen] = useState(false);
  const [phoneNumbersUserId, setPhoneNumbersUserId] = useState<string | null>(null);

  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [viewTemplateOpen, setViewTemplateOpen] = useState(false);
  const [editTemplateOpen, setEditTemplateOpen] = useState(false);
  const [deleteTemplateOpen, setDeleteTemplateOpen] = useState(false);

  const [userForm, setUserForm] = useState<UserFormState>(EMPTY_USER_FORM);
  const [initialUserForm, setInitialUserForm] = useState<UserFormState>(EMPTY_USER_FORM);
  const [templateForm, setTemplateForm] = useState<TemplateFormState>(EMPTY_TEMPLATE_FORM);
  const [permissionSearch, setPermissionSearch] = useState('');
  const [openTemplatePermissionGroups, setOpenTemplatePermissionGroups] = useState<string[]>([]);
  const [savingUser, setSavingUser] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const canManageTemplates = meta?.canManageTemplates ?? role === 'super';
  const canManageGlobalUsers = canManageTemplates;
  const activeUser = users.find((item) => item.id === activeUserId) ?? null;
  const activeTemplate = templates.find((item) => item.id === activeTemplateId) ?? null;
  const detailUserIndex = employeeId ? users.findIndex((item) => item.id === employeeId) : -1;
  const detailActionUser = detailUserIndex >= 0 ? users[detailUserIndex] : null;
  const detailManagerProfile = detailActionUser?.managerProfiles[0] ?? null;
  const detailEmployeeProfileId = detailManagerProfile?.id
    ?? (!loading && employeeId && !detailActionUser ? employeeId : null);
  const dealershipMap = useMemo(() => new Map((meta?.dealerships || []).map((item) => [item.id, item])), [meta]);
  const holdingFilterOptions = useMemo<SelectOption[]>(
    () => (meta?.holdings || []).map((holding) => ({
      value: holding.id,
      label: holding.name,
    })),
    [meta],
  );
  const dealershipFilterOptions = useMemo<SelectOption[]>(
    () => (meta?.dealerships || []).map((dealership) => ({
      value: dealership.id,
      label: dealership.name,
      description: dealership.holdingName || 'Без компании',
    })),
    [meta],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [metaData, userData] = await Promise.all([
          fetchRbacMeta(),
          fetchUsers(),
        ]);
        const templateData = metaData.canManageTemplates ? await fetchPermissionTemplates() : [];
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
  }, []);

  const userEmployeeRows = useMemo<UserEmployeeRow[]>(() => {
    let list = users.map((user) => {
      const dealershipNames = userDealershipNames(user);
      return {
        user,
        fullName: userFullName(user),
        dealershipNames,
        dealershipName: dealershipNames.join(', ') || userScopeLabel(user),
        city: user.managerProfiles[0]?.holdingName || user.memberships[0]?.holdingName || '',
      };
    });
    if (search.trim()) {
      const q = normalizeSearchValue(search);
      list = list.filter((row) =>
        normalizeSearchValue(row.fullName).includes(q) ||
        normalizeSearchValue(row.user.email).includes(q) ||
        normalizeSearchValue(row.dealershipName).includes(q) ||
        normalizeSearchValue(row.city).includes(q),
      );
    }
    if (fullNameFilter.trim()) {
      const q = normalizeSearchValue(fullNameFilter);
      list = list.filter((row) => normalizeSearchValue(row.fullName).includes(q));
    }
    if (emailFilter.trim()) {
      const q = normalizeSearchValue(emailFilter);
      list = list.filter((row) => normalizeSearchValue(row.user.email).includes(q));
    }
    if (phoneFilter.trim()) {
      const q = normalizePhoneValue(phoneFilter);
      list = list.filter((row) => q && userPhoneHaystack(row.user).includes(q));
    }
    if (roleFilter.length > 0) {
      list = list.filter((row) => row.user.memberships.some((membership) => roleFilter.includes(membership.role)));
    }
    if (holdingFilter) {
      list = list.filter((row) => userMatchesScope(row.user, `holding:${holdingFilter}`));
    }
    if (selectedGlobalHoldingId) {
      list = list.filter((row) => userMatchesScope(row.user, `holding:${selectedGlobalHoldingId}`));
    }
    if (dealershipFilter) {
      list = list.filter((row) => userMatchesScope(row.user, `dealership:${dealershipFilter}`));
    }
    if (ownershipFilter !== 'all') {
      list = list.filter((row) => userMatchesOwnership(row.user, ownershipFilter));
    }

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (userSortKey === 'fullName') cmp = a.fullName.localeCompare(b.fullName, 'ru');
      else if (userSortKey === 'dealershipName') cmp = a.dealershipName.localeCompare(b.dealershipName, 'ru');
      else if (userSortKey === 'status') cmp = a.user.analytics.status.localeCompare(b.user.analytics.status, 'ru');
      else cmp = (a.user.analytics[userSortKey] ?? -Infinity) - (b.user.analytics[userSortKey] ?? -Infinity);
      return userSortDir === 'asc' ? cmp : -cmp;
    });
  }, [dealershipFilter, emailFilter, fullNameFilter, holdingFilter, ownershipFilter, phoneFilter, roleFilter, search, selectedGlobalHoldingId, userSortDir, userSortKey, users]);

  const activeUserFiltersCount = [
    fullNameFilter.trim(),
    emailFilter.trim(),
    phoneFilter.trim(),
    roleFilter.length > 0 ? 'roles' : '',
    holdingFilter,
    dealershipFilter,
    ownershipFilter !== 'all' ? ownershipFilter : '',
  ].filter(Boolean).length;

  const groupedTemplatePermissions = useMemo(() => {
    const q = permissionSearch.trim().toLowerCase();
    const groups = new Map<string, {
      id: string;
      title: string;
      description: string;
      permissions: PermissionDefinition[];
    }>();

    for (const permission of meta?.permissions || []) {
      const label = permissionLabel(permission.key);
      const haystack = [label, permission.key, permission.description, permission.scopes.join(' ')].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) continue;

      const group = permissionGroupFor(permission.key);
      const existing = groups.get(group.id);
      if (existing) {
        existing.permissions.push(permission);
      } else {
        groups.set(group.id, {
          id: group.id,
          title: group.title,
          description: group.description,
          permissions: [permission],
        });
      }
    }

    return Array.from(groups.values());
  }, [meta?.permissions, permissionSearch]);

  const activeTemplatePermissionGroups = useMemo(() => {
    if (!activeTemplate) return [];

    const selected = new Set(activeTemplate.permissions);
    const groups = new Map<string, {
      id: string;
      title: string;
      description: string;
      total: number;
      selected: PermissionDefinition[];
    }>();

    for (const permission of meta?.permissions || []) {
      const group = permissionGroupFor(permission.key);
      const existing = groups.get(group.id);
      const next = existing || {
        id: group.id,
        title: group.title,
        description: group.description,
        total: 0,
        selected: [],
      };
      next.total += 1;
      if (selected.has(permission.key)) next.selected.push(permission);
      groups.set(group.id, next);
    }

    for (const permissionKey of activeTemplate.permissions) {
      const known = meta?.permissions.some((permission) => permission.key === permissionKey);
      if (known) continue;
      const group = permissionGroupFor(permissionKey);
      const existing = groups.get(group.id);
      const fallbackPermission: PermissionDefinition = {
        key: permissionKey,
        description: 'Описание для этого права пока не задано.',
        scopes: [],
      };
      if (existing) {
        existing.total += 1;
        existing.selected.push(fallbackPermission);
      } else {
        groups.set(group.id, {
          id: group.id,
          title: group.title,
          description: group.description,
          total: 1,
          selected: [fallbackPermission],
        });
      }
    }

    return Array.from(groups.values()).filter((group) => group.selected.length > 0);
  }, [activeTemplate, meta?.permissions]);

  useEffect(() => {
    if (viewTemplateOpen) setOpenTemplatePermissionGroups([]);
  }, [viewTemplateOpen, activeTemplateId]);

  function suggestedTemplateIdForRole(nextRole: string): string {
    const templateName = defaultTemplateNameForRole(nextRole);
    if (!templateName) return '';
    return templates.find((template) => template.name === templateName)?.id || '';
  }

  useEffect(() => {
    if (!editUserOpen || !canManageTemplates) return;
    const firstRole = canManageGlobalUsers ? userForm.memberships[0]?.role : 'manager';
    const templateId = suggestedTemplateIdForRole(firstRole || 'manager');
    setUserForm((current) => {
      const nextTemplateIds = templateId ? [templateId] : [];
      if (current.templateIds[0] === nextTemplateIds[0] && current.templateIds.length === nextTemplateIds.length) return current;
      return { ...current, templateIds: nextTemplateIds };
    });
  }, [canManageGlobalUsers, canManageTemplates, editUserOpen, templates, userForm.memberships]);

  function openEditUser(user: UserAccountItem) {
    setActiveUserId(user.id);
    const nextForm = buildUserForm(user);
    setUserForm(nextForm);
    setInitialUserForm(nextForm);
    setEditDeleteConfirm(false);
    setUserUnsavedOpen(false);
    setEditUserOpen(true);
  }

  function buildUserForm(user: UserAccountItem): UserFormState {
    const firstProfile = user.managerProfiles[0];
    return {
      email: user.email,
      password: '',
      displayName: firstProfile?.fullName || user.displayName || '',
      status: user.status,
      memberships: user.memberships.length
        ? user.memberships.map((membership) => ({
            role: membership.role,
            holdingId: membership.holdingId || '',
            dealershipId: membership.dealershipId || '',
          }))
        : [{ role: 'manager', holdingId: '', dealershipId: '' }],
      managerFullName: firstProfile?.fullName || user.displayName || '',
      managerEmail: firstProfile?.email || '',
      managerPhone: firstProfile?.phone || '',
      managerStatus: firstProfile?.status || 'active',
      templateIds: user.permissionTemplates.map((template) => template.id),
    };
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

  function updateMembershipRole(index: number, nextRole: string) {
    const templateId = suggestedTemplateIdForRole(nextRole);
    setUserForm((current) => ({
      ...current,
      memberships: current.memberships.map((membership, membershipIndex) =>
        membershipIndex === index ? { ...membership, role: nextRole, holdingId: '', dealershipId: '' } : membership,
      ),
      templateIds: canManageTemplates && templateId ? [templateId] : current.templateIds,
    }));
  }

  function availableDealerships(membership: MembershipForm) {
    const all = meta?.dealerships || [];
    if (membership.holdingId === NO_HOLDING_VALUE) return all.filter((item) => !item.holdingId);
    if (!membership.holdingId) return [];
    return all.filter((item) => item.holdingId === membership.holdingId);
  }

  async function saveUser(mode: 'create' | 'edit', form: UserFormState = userForm) {
    const fullName = form.managerFullName.trim();
    const memberships = (!canManageGlobalUsers
      ? form.memberships.map((membership) => ({ ...membership, role: 'manager' }))
      : form.memberships
    )
      .map((membership) => ({
        ...membership,
        holdingId: membership.holdingId === NO_HOLDING_VALUE ? '' : membership.holdingId,
      }))
      .filter((membership) => membership.role && (membership.holdingId || membership.dealershipId || membership.role === 'platform_superadmin'));

    const profileMembership = memberships.find((membership) => membership.dealershipId);
    const managerProfiles = fullName && profileMembership?.dealershipId
      ? [{
          fullName,
          dealershipId: profileMembership.dealershipId,
          email: form.email || null,
          phone: null,
          status: form.managerStatus,
        }]
      : [];

    const payload: Record<string, unknown> = {
      email: form.email,
      displayName: fullName || null,
      status: form.status,
      memberships,
      managerProfiles,
      templateIds: canManageTemplates ? form.templateIds : [],
    };
    if (form.password.trim()) payload.password = form.password;

    if (mode === 'create') {
      return createUser({ ...payload, password: form.password });
    }
    if (!activeUserId) throw new Error('Сотрудник не выбран.');
    return updateUser(activeUserId, payload);
  }

  async function handleCreateUser(form: UserFormState) {
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveUser('create', form);
      await reloadUsers();
      if (saved) setActiveUserId(saved.id);
      setCreateUserOpen(false);
      setNotice('Сотрудник создан.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать сотрудника.');
    } finally {
      setSavingUser(false);
    }
  }

  async function persistUserEdit(): Promise<boolean> {
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      await saveUser('edit');
      await reloadUsers();
      setEditUserOpen(false);
      setEditDeleteConfirm(false);
      setUserUnsavedOpen(false);
      setNotice('Сотрудник обновлён.');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить сотрудника.');
      return false;
    } finally {
      setSavingUser(false);
    }
  }

  async function handleEditUser(event: React.FormEvent) {
    event.preventDefault();
    const isDirty = JSON.stringify(normalizeUserForm(userForm)) !== JSON.stringify(normalizeUserForm(initialUserForm));
    if (!isDirty) return;
    await persistUserEdit();
  }

  function requestCloseEditUserModal() {
    const isDirty = JSON.stringify(normalizeUserForm(userForm)) !== JSON.stringify(normalizeUserForm(initialUserForm));
    if (isDirty) {
      setUserUnsavedOpen(true);
      return;
    }
    setEditUserOpen(false);
    setEditDeleteConfirm(false);
    setUserUnsavedOpen(false);
  }

  async function handleDeleteUserConfirm() {
    if (!activeUserId) return;
    setSavingUser(true);
    setError(null);
    setNotice(null);
    try {
      await deleteUser(activeUserId);
      await reloadUsers();
      setEditDeleteConfirm(false);
      setViewUserOpen(false);
      setEditUserOpen(false);
      setUserUnsavedOpen(false);
      setActiveUserId(null);
      setNotice('Сотрудник удалён.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить сотрудника.');
    } finally {
      setSavingUser(false);
    }
  }

  async function handleCreateTemplate() {
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

  async function handleEditTemplate() {
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

  function handleUserSort(key: UserSortKey) {
    if (userSortKey === key) {
      setUserSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setUserSortKey(key);
    setUserSortDir(key === 'fullName' || key === 'dealershipName' || key === 'status' ? 'asc' : 'desc');
  }

  function renderUserForm(onSubmit: (event: React.FormEvent) => void, options?: { showStatus?: boolean }) {
    const showStatus = options?.showStatus ?? true;
    return (
      <form id={EDIT_USER_FORM_ID} onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
        <label className="sa-form-field">
          <span>Email</span>
          <input className="sa-search-input" value={userForm.email} onChange={(event) => setUserForm((current) => ({ ...current, email: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Новый пароль</span>
          <input
            type="password"
            className="sa-search-input"
            value={userForm.password}
            placeholder="Оставьте пустым, если не меняете"
            onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
            autoComplete="new-password"
          />
        </label>
        <label className="sa-form-field">
          <span>ФИО</span>
          <input className="sa-search-input" value={userForm.managerFullName} onChange={(event) => setUserForm((current) => ({ ...current, managerFullName: event.target.value, displayName: event.target.value }))} />
        </label>
        {showStatus && (
          <div style={{ display: 'grid', gap: 6 }}>
            <span>Состояние аккаунта</span>
            <SingleSelectFilterPicker
              value={userForm.status}
              options={[
                { value: 'active', label: 'Аккаунт включен' },
                { value: 'invited', label: 'Приглашение отправлено' },
                { value: 'disabled', label: 'Аккаунт выключен' },
              ]}
              onChange={(status) => setUserForm((current) => ({ ...current, status }))}
            />
          </div>
        )}
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Доступ сотрудника</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {userForm.memberships.map((membership, index) => {
              const dealerships = availableDealerships(membership);
              const holdingId = membership.holdingId || dealershipMap.get(membership.dealershipId)?.holdingId || '';
              const roleOptions = !canManageGlobalUsers
                ? [{ value: 'manager', label: roleLabel('manager'), description: roleDescription('manager') }]
                : (meta?.roles || []).map((item) => ({ value: item, label: roleLabel(item), description: roleDescription(item) }));
              const holdingOptions = [
                ...(membership.role === 'dealership_admin' || membership.role === 'manager'
                  ? [{ value: NO_HOLDING_VALUE, label: 'Без компании', description: 'Показать точки без привязки к компании' }]
                  : []),
                ...(meta?.holdings || []).map((item) => ({ value: item.id, label: item.name })),
              ];
              const dealershipOptions = dealerships.map((item) => ({
                value: item.id,
                label: item.name,
                description: item.holdingName || 'Без компании',
              }));
              return (
                <div key={`${index}-${membership.role}-${membership.dealershipId}`} style={{ display: 'grid', gap: 10 }}>
                  <SearchableSelect
                    label="Права"
                    value={canManageGlobalUsers ? membership.role : 'manager'}
                    disabled={!canManageGlobalUsers}
                    options={roleOptions}
                    placeholder="Выберите права сотрудника"
                    onChange={(value) => updateMembershipRole(index, value)}
                  />
                  {membership.role === 'holding_admin' && (
                    <SearchableSelect
                      label="Компания"
                      value={holdingId}
                      options={(meta?.holdings || []).map((item) => ({ value: item.id, label: item.name }))}
                      placeholder="Выберите компанию"
                      onChange={(value) => updateMembership(index, { holdingId: value, dealershipId: '' })}
                    />
                  )}
                  {(membership.role === 'dealership_admin' || membership.role === 'manager') && (
                    <>
                      <SearchableSelect
                        label="Компания"
                        value={holdingId}
                        options={holdingOptions}
                        placeholder="Выберите компанию"
                        onChange={(value) => updateMembership(index, { holdingId: value, dealershipId: '' })}
                      />
                      <SearchableSelect
                        label="Точка"
                        value={membership.dealershipId}
                        options={dealershipOptions}
                        placeholder={holdingId ? 'Выберите точку' : 'Сначала выберите компанию'}
                        onChange={(value) => {
                          const selectedDealership = dealershipMap.get(value);
                          updateMembership(index, {
                            dealershipId: value,
                            holdingId: selectedDealership?.holdingId || NO_HOLDING_VALUE,
                          });
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </form>
    );
  }

  function renderEditUserFormFooter() {
    const isDirty = JSON.stringify(normalizeUserForm(userForm)) !== JSON.stringify(normalizeUserForm(initialUserForm));
    const isSubmitDisabled = savingUser || !isDirty;
    return (
      <div className="sa-modal-footer-row">
        <button type="button" className="sa-btn-danger" onClick={() => setEditDeleteConfirm(true)}>
          Удалить сотрудника
        </button>
        <div className="sa-modal-footer-row__right">
          <button type="button" className="sa-btn-outline" onClick={requestCloseEditUserModal} disabled={savingUser}>
            Отмена
          </button>
          <button type="submit" form={EDIT_USER_FORM_ID} className="sa-btn-primary" disabled={isSubmitDisabled}>
            {savingUser ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </div>
      </div>
    );
  }

  function renderTemplateForm() {
    const selectedCount = templateForm.permissions.length;
    const totalCount = meta?.permissions.length || 0;

    function togglePermission(permissionKey: string) {
      setTemplateForm((current) => ({
        ...current,
        permissions: current.permissions.includes(permissionKey)
          ? current.permissions.filter((item) => item !== permissionKey)
          : [...current.permissions, permissionKey],
      }));
    }

    function setGroupPermissions(permissionKeys: string[], enabled: boolean) {
      setTemplateForm((current) => {
        const next = new Set(current.permissions);
        for (const permissionKey of permissionKeys) {
          if (enabled) next.add(permissionKey);
          else next.delete(permissionKey);
        }
        return { ...current, permissions: Array.from(next) };
      });
    }

    return (
      <form id={TEMPLATE_FORM_ID} onSubmit={(event) => event.preventDefault()} style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Название шаблона</span>
          <input
            className="sa-input"
            value={templateForm.name}
            onChange={(event) => setTemplateForm((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Описание</span>
          <textarea
            className="sa-input"
            rows={3}
            value={templateForm.description}
            onChange={(event) => setTemplateForm((current) => ({ ...current, description: event.target.value }))}
          />
        </label>

        <div className="sa-bordered-block" style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700 }}>Права доступа</div>
              <div className="sa-meta" style={{ marginTop: 4 }}>
                Выбрано {selectedCount} из {totalCount}. Технические коды показаны мелким текстом для проверки.
              </div>
            </div>
            <button
              type="button"
              className="sa-btn-text"
              onClick={() => setTemplateForm((current) => ({ ...current, permissions: [] }))}
              disabled={selectedCount === 0}
            >
              Снять всё
            </button>
          </div>

          <input
            className="sa-input"
            placeholder="Найти право: звонки, сотрудники, дашборд..."
            value={permissionSearch}
            onChange={(event) => setPermissionSearch(event.target.value)}
          />

          <div className="sa-template-permissions-scroll">
            {groupedTemplatePermissions.length === 0 && (
              <div className="sa-bordered-block sa-meta">
                Ничего не найдено. Попробуйте другой запрос.
              </div>
            )}

            {groupedTemplatePermissions.map((group) => {
              const groupKeys = group.permissions.map((permission) => permission.key);
              const selectedInGroup = groupKeys.filter((key) => templateForm.permissions.includes(key)).length;
              const allSelected = selectedInGroup === groupKeys.length && groupKeys.length > 0;

              return (
                <section key={group.id} className="sa-bordered-block" style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{group.title}</div>
                      <div className="sa-meta" style={{ marginTop: 4 }}>{group.description}</div>
                    </div>
                    <button
                      type="button"
                      className="sa-btn-text"
                      onClick={() => setGroupPermissions(groupKeys, !allSelected)}
                    >
                      {allSelected ? 'Снять раздел' : 'Выбрать раздел'}
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="sa-metric-chip">{selectedInGroup}/{groupKeys.length} выбрано</span>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {group.permissions.map((permission) => {
                      const checked = templateForm.permissions.includes(permission.key);
                      return (
                        <label
                          key={permission.key}
                          className={`sa-permission-option${checked ? ' is-checked' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePermission(permission.key)}
                          />
                          <span>
                            <span className="sa-permission-option__title">{permissionLabel(permission.key)}</span>
                            <span className="sa-permission-option__desc">{permission.description}</span>
                            <span className="sa-permission-option__code">{permission.key}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </form>
    );
  }

  function renderTemplateFormFooter(options: {
    submitLabel: string;
    onClose: () => void;
    onSubmit: () => void;
  }) {
    return (
      <div className="sa-modal-footer-row">
        <div className="sa-modal-footer-row__right">
          <button type="button" className="sa-btn-outline" onClick={options.onClose} disabled={savingTemplate}>
            Отмена
          </button>
          <button
            type="button"
            className="sa-btn-primary"
            disabled={savingTemplate}
            onClick={options.onSubmit}
          >
            {savingTemplate ? 'Сохраняем...' : options.submitLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {employeeId ? (
        null
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
          <h1 className="sa-page-title" style={{ marginBottom: 0 }}>Сотрудники</h1>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <HoldingSelectPicker
              holdings={meta?.holdings || []}
              value={selectedGlobalHoldingId}
              onChange={setSelectedGlobalHoldingId}
              disabled={loading || (meta?.holdings || []).length === 0}
              loading={loading}
            />
            {tab === 'templates' && canManageTemplates && (
              <button
                type="button"
                className="sa-btn-brutal-3d"
                onClick={() => {
                  resetTemplateForm();
                  setPermissionSearch('');
                  setCreateTemplateOpen(true);
                }}
              >
                <LetsIcon name="add-light" size={16} bold />
                Новый шаблон
              </button>
            )}
          </div>
        </div>
      )}

      {error && <div className="sa-card" style={{ marginBottom: 16, color: '#991B1B', background: '#FEF2F2' }}>{error}</div>}
      {notice && <div className="sa-card" style={{ marginBottom: 16, color: '#166534', background: '#F0FDF4' }}>{notice}</div>}

      {employeeId && loading ? (
        null
      ) : employeeId && detailEmployeeProfileId ? (
        <EmployeeDetail
          employeeId={detailEmployeeProfileId}
          onBack={() => onBackToUsers?.()}
          onOpenDealership={onOpenDealership}
          onOpenCompanies={onOpenCompanies}
          sourceDealership={sourceDealership}
          detailOverride={detailActionUser ? {
            fullName: userFullName(detailActionUser),
            dealershipName: detailActionUser.managerProfiles[0]?.dealershipName
              || userDealershipNames(detailActionUser)[0]
              || '',
            city: (() => {
              const dealership = detailActionUser.managerProfiles[0]?.dealershipName
                || userDealershipNames(detailActionUser)[0]
                || '';
              const holding = detailActionUser.managerProfiles[0]?.holdingName
                || detailActionUser.memberships[0]?.holdingName
                || '';
              return holding && holding.toLowerCase() !== dealership.toLowerCase() ? holding : '';
            })(),
          } : undefined}
          actionButtons={detailActionUser && (
            <>
              <button type="button" className="sa-btn-brutal-3d" onClick={() => openEditUser(detailActionUser)}>
                <EditIcon />
                Редактировать
              </button>
              <button type="button" className="sa-btn-brutal-3d" onClick={() => setPhoneNumbersUserId(detailActionUser.id)}>
                <PhoneIcon />
                Номера телефонов
              </button>
            </>
          )}
        />
      ) : employeeId ? (
        <div className="sa-card" style={{ padding: 24 }}>
          <button type="button" className="sa-btn-text" onClick={() => onBackToUsers?.()} style={{ marginBottom: 16 }}>
            Назад к сотрудникам
          </button>
          <h2 className="sa-card-heading">Профиль менеджера не привязан</h2>
          <p className="sa-meta" style={{ margin: 0 }}>
            У этого web-аккаунта пока нет профиля для звонков. Добавьте точку в назначениях сотрудника, чтобы открыть аналитику.
          </p>
        </div>
      ) : (
        <>
      <div className="sa-dialog-tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`sa-dialog-tab ${tab === 'users' ? 'sa-dialog-tab-active' : ''}`}
          onClick={() => setTab('users')}
        >
          Списки сотрудников
        </button>
        {canManageTemplates && (
          <button
            type="button"
            className={`sa-dialog-tab ${tab === 'templates' ? 'sa-dialog-tab-active' : ''}`}
            onClick={() => setTab('templates')}
          >
            Шаблоны прав
          </button>
        )}
      </div>

      {tab === 'users' && (
        <>
          <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
            <div className="sa-toolbar-filters">
              <div className="sa-search-wrap">
                <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  className="sa-search-input"
                  placeholder="Поиск по имени / точке / городу..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <FiltersToggleButton
                active={showUserFilters}
                count={activeUserFiltersCount}
                onClick={() => setShowUserFilters((current) => !current)}
              />
            </div>
            <div className="sa-toolbar-actions">
              <button
                type="button"
                className="sa-btn-brutal-3d"
                onClick={() => {
                  setCreateUserOpen(true);
                }}
              >
                <LetsIcon name="add-light" size={16} bold />
                Новый сотрудник
              </button>
            </div>
          </div>

          {showUserFilters && (
            <FiltersPanel
              onReset={() => {
                setFullNameFilter('');
                setEmailFilter('');
                setPhoneFilter('');
                setRoleFilter([]);
                setHoldingFilter('');
                setDealershipFilter('');
                setOwnershipFilter('all');
              }}
            >
              <FilterGroup label="Данные сотрудника">
                <input className="sa-input" style={{ minWidth: 0, flex: '1 1 180px' }} value={fullNameFilter} onChange={(event) => setFullNameFilter(event.target.value)} placeholder="ФИО" />
                <input className="sa-input" style={{ minWidth: 0, flex: '1 1 180px' }} value={emailFilter} onChange={(event) => setEmailFilter(event.target.value)} placeholder="Электронная почта" />
                <input className="sa-input" style={{ minWidth: 0, flex: '1 1 160px' }} value={phoneFilter} onChange={(event) => setPhoneFilter(event.target.value)} placeholder="Телефон" />
              </FilterGroup>

              <FilterGroup label="Роль">
                {(meta?.roles || []).map((item) => (
                  <label key={item} className="sa-filter-check">
                    <input
                      type="checkbox"
                      checked={roleFilter.includes(item)}
                      onChange={() => setRoleFilter((current) => (
                        current.includes(item)
                          ? current.filter((role) => role !== item)
                          : [...current, item]
                      ))}
                    />
                    {roleLabel(item)}
                  </label>
                ))}
              </FilterGroup>

              <FilterGroup label="Компания">
                <div className="sa-tag-filter-picker-wrap" style={{ minWidth: 0, flex: '1 1 260px', maxWidth: 420 }}>
                  <SingleSelectFilterPicker
                    value={holdingFilter}
                    options={[
                      { value: '', label: 'Все компании' },
                      ...holdingFilterOptions.map((option) => ({ value: option.value, label: option.label })),
                    ]}
                    placeholder="Все компании"
                    onChange={setHoldingFilter}
                  />
                </div>
              </FilterGroup>

              <FilterGroup label="Точка">
                <div className="sa-tag-filter-picker-wrap" style={{ minWidth: 0, flex: '1 1 260px', maxWidth: 420 }}>
                  <SingleSelectFilterPicker
                    value={dealershipFilter}
                    options={[
                      { value: '', label: 'Все точки' },
                      ...dealershipFilterOptions.map((option) => ({ value: option.value, label: option.label })),
                    ]}
                    placeholder="Все точки"
                    onChange={setDealershipFilter}
                  />
                </div>
              </FilterGroup>

              <FilterGroup label="Франшиза / Свои">
                {[
                  { value: 'all' as UserOwnershipFilter, label: 'Все' },
                  { value: 'own' as UserOwnershipFilter, label: 'Свои' },
                  { value: 'franchised' as UserOwnershipFilter, label: 'Франшиза' },
                ].map((option) => (
                  <label key={option.value} className="sa-filter-check">
                    <input
                      type="radio"
                      name="user-ownership-filter"
                      checked={ownershipFilter === option.value}
                      onChange={() => setOwnershipFilter(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </FilterGroup>
            </FiltersPanel>
          )}

          <div className="sa-companies-table-wrap sa-holdings-table-wrap sa-desktop-only">
            <table className="sa-table sa-table-sortable sa-holdings-table sa-users-table">
              <colgroup>
                <col className="sa-col-user" />
                <col className="sa-col-dealership" />
                <col className="sa-col-num" />
                <col className="sa-col-num" />
                <col className="sa-col-num" />
                <col className="sa-col-num" />
                <col className="sa-col-status" />
                <col className="sa-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  {USER_COLUMN_DEFS.map((col) => (
                    <th
                      key={col.key}
                      className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`}
                      onClick={() => handleUserSort(col.key)}
                    >
                      {col.label}{' '}
                      <span className={userSortKey === col.key ? 'sa-sort-icon' : 'sa-sort-icon sa-sort-icon-inactive'}>
                        {userSortKey === col.key ? (userSortDir === 'asc' ? '↑' : '↓') : '⇅'}
                      </span>
                    </th>
                  ))}
                  <th className="sa-th-sortable" onClick={() => handleUserSort('status')}>
                    Статус{' '}
                    <span className={userSortKey === 'status' ? 'sa-sort-icon' : 'sa-sort-icon sa-sort-icon-inactive'}>
                      {userSortKey === 'status' ? (userSortDir === 'asc' ? '↑' : '↓') : '⇅'}
                    </span>
                  </th>
                  <th className="sa-text-right sa-holdings-actions-col">Действия</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="sa-meta" style={{ padding: 32 }}>Загрузка...</td></tr>
                ) : userEmployeeRows.length === 0 ? (
                  <tr><td colSpan={8} className="sa-meta" style={{ padding: 32 }}>
                    Нет сотрудников по выбранным фильтрам
                    <br /><span style={{ fontSize: 12, opacity: 0.7 }}>Сбросьте фильтры или измените поиск</span>
                  </td></tr>
                ) : (
                  userEmployeeRows.map((row) => {
                    const actionUser = row.user;
                    const analytics = row.user.analytics;
                    const delta = deltaDisplay(analytics.deltaRating);
                    return (
                      <tr
                        key={row.user.id}
                        className="sa-row-clickable"
                        onClick={() => onSelectEmployee?.(row.user.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => event.key === 'Enter' && onSelectEmployee?.(row.user.id)}
                      >
                        <td>
                          <div className="sa-cell-name">{row.fullName}</div>
                          <div className="sa-cell-city">{row.user.email}</div>
                        </td>
                        <td>
                          {row.dealershipNames.length > 0 ? (
                            <div className="sa-cell-name">{row.dealershipNames.join(', ')}</div>
                          ) : (
                            <>
                              <div className="sa-cell-name">{row.dealershipName}</div>
                              {row.city ? <div className="sa-cell-city">{row.city}</div> : null}
                            </>
                          )}
                        </td>
                        <td className="sa-text-right"><span className={ratingClass(analytics.aiRating)}>{analytics.aiRating}</span></td>
                        <td className="sa-text-right"><span className={delta.cls}>{delta.text}</span></td>
                        <td className="sa-text-right">{analytics.auditsCount}</td>
                        <td className="sa-text-right">
                          <span className={analytics.failsCount >= 2 ? 'sa-score-red' : analytics.failsCount >= 1 ? 'sa-score-orange' : ''}>
                            {analytics.failsCount}
                          </span>
                        </td>
                        <td><span className={statusBadgeClass(analytics.status)}>{USER_ANALYTICS_STATUS_LABELS[analytics.status]}</span></td>
                        <td className="sa-holdings-actions-cell" onClick={(event) => event.stopPropagation()}>
                          <div>
                            <button
                              type="button"
                              className="sa-btn-icon sa-btn-brutal-3d-icon"
                              onClick={() => actionUser && openEditUser(actionUser)}
                              aria-label="Редактировать"
                              title="Редактировать"
                            >
                              <EditIcon />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="sa-mobile-only">
            {loading ? (
              <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</div>
                ) : userEmployeeRows.length === 0 ? (
              <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Нет сотрудников по выбранным фильтрам</div>
            ) : (
              userEmployeeRows.map((row) => {
                const analytics = row.user.analytics;
                const delta = deltaDisplay(analytics.deltaRating);
                const actionUser = row.user;
                return (
                  <div
                    key={row.user.id}
                    className="sa-mobile-row"
                    onClick={() => onSelectEmployee?.(row.user.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="sa-mobile-row-header">
                      <div>
                        <div className="sa-cell-name">{row.fullName}</div>
                        <div className="sa-cell-city">{row.dealershipName} · {row.city}</div>
                      </div>
                      <span className={`sa-mobile-rating ${ratingClass(analytics.aiRating)}`}>{analytics.aiRating}</span>
                    </div>
                    <div className="sa-mobile-chips">
                      <span className="sa-metric-chip"><span className={delta.cls}>{delta.text}</span></span>
                      <span className="sa-metric-chip">Проверки: {analytics.auditsCount}</span>
                      <span className="sa-metric-chip">Провалы: {analytics.failsCount}</span>
                      <span className={statusBadgeClass(analytics.status)}>{USER_ANALYTICS_STATUS_LABELS[analytics.status]}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="sa-btn-icon sa-btn-brutal-3d-icon"
                        onClick={() => actionUser && openEditUser(actionUser)}
                        aria-label="Редактировать"
                        title="Редактировать"
                      >
                        <EditIcon />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {tab === 'templates' && canManageTemplates && (
        templates.length === 0 ? (
          <div className="sa-meta" style={{ padding: 12 }}>
            {loading ? 'Загрузка...' : 'Шаблонов пока нет'}
          </div>
        ) : (
          <div className="sa-templates-list">
            {templates.map((template) => (
              <div
                key={template.id}
                className="sa-template-card"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setActiveTemplateId(template.id);
                  setViewTemplateOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveTemplateId(template.id);
                    setViewTemplateOpen(true);
                  }
                }}
              >
                <div className="sa-template-card__body">
                  <div style={{ fontWeight: 700 }}>{template.name}</div>
                  <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>{template.description || 'Без описания'}</div>
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <span className="sa-metric-chip">{template.assignedAccountsCount} назначений</span>
                    {template.permissions.slice(0, 6).map((permission) => (
                      <span key={permission} className="sa-metric-chip">{permissionLabel(permission)}</span>
                    ))}
                    {template.isSystem && <span className="sa-metric-chip">Системный</span>}
                  </div>
                </div>
                {!template.isSystem && (
                  <div
                    className="sa-template-card__actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="sa-btn-danger"
                      onClick={() => {
                        setActiveTemplateId(template.id);
                        setDeleteTemplateOpen(true);
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
        </>
      )}

      <CreateUserModal
        open={createUserOpen}
        onClose={() => setCreateUserOpen(false)}
        onSubmit={handleCreateUser}
        meta={meta}
        templates={templates}
        canManageTemplates={canManageTemplates}
        canManageGlobalUsers={canManageGlobalUsers}
        saving={savingUser}
      />

      <ModalFrame
        title="Просмотр сотрудника"
        subtitle="Детальная карточка сотрудника без режима редактирования."
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
                { label: 'Состояние', value: statusLabel(activeUser.status) },
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
                  <div key={profile.id}>{profile.fullName} · {profile.dealershipName} · {profile.holdingName || 'Без компании'}</div>
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
        title="Редактировать сотрудника"
        subtitle="Изменение сотрудника выполняется через отдельное модальное окно."
        open={editUserOpen}
        onClose={requestCloseEditUserModal}
        footer={renderEditUserFormFooter()}
      >
        {renderUserForm(handleEditUser)}
      </ModalFrame>

      <UnsavedChangesModal
        open={userUnsavedOpen && editUserOpen}
        saving={savingUser}
        onCancel={() => setUserUnsavedOpen(false)}
        onDiscard={() => {
          setUserUnsavedOpen(false);
          setEditUserOpen(false);
          setEditDeleteConfirm(false);
        }}
        onSave={() => { void persistUserEdit(); }}
      />

      <DeleteConfirmModal
        open={editDeleteConfirm && editUserOpen}
        title="Удалить сотрудника?"
        saving={savingUser}
        onCancel={() => setEditDeleteConfirm(false)}
        onConfirm={() => { void handleDeleteUserConfirm(); }}
      />

      <ModalFrame
        title="Новый шаблон прав"
        subtitle="Создание шаблона прав вынесено в отдельное модальное окно."
        open={createTemplateOpen}
        onClose={() => setCreateTemplateOpen(false)}
        width={760}
        footer={renderTemplateFormFooter({
          submitLabel: 'Создать шаблон',
          onClose: () => setCreateTemplateOpen(false),
          onSubmit: () => { void handleCreateTemplate(); },
        })}
      >
        {renderTemplateForm()}
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
            <div className="sa-bordered-block" style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontWeight: 700 }}>Права доступа</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {activeTemplatePermissionGroups.map((group) => {
                  const isOpen = openTemplatePermissionGroups.includes(group.id);
                  return (
                    <div key={group.id} className="sa-template-accordion">
                      <button
                        type="button"
                        className="sa-template-accordion__header"
                        onClick={() =>
                          setOpenTemplatePermissionGroups((current) =>
                            current.includes(group.id)
                              ? current.filter((item) => item !== group.id)
                              : [...current, group.id],
                          )
                        }
                      >
                        <span>
                          <span className="sa-template-accordion__title">{group.title}</span>
                          <span className="sa-template-accordion__desc">{group.description}</span>
                        </span>
                        <span className="sa-template-accordion__meta">
                          <span className="sa-metric-chip">{group.selected.length}/{group.total}</span>
                          <span aria-hidden="true">{isOpen ? '▲' : '▼'}</span>
                        </span>
                      </button>

                      {isOpen && (
                        <div className="sa-template-accordion__body">
                          {group.selected.map((permission) => (
                            <div key={permission.key} className="sa-bordered-block">
                              <div style={{ fontWeight: 700 }}>{permissionLabel(permission.key)}</div>
                              <div className="sa-meta" style={{ marginTop: 4 }}>
                                {permission.description}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {activeTemplatePermissionGroups.length === 0 && (
                  <div className="sa-meta">В шаблоне пока нет выбранных прав.</div>
                )}
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
        width={760}
        footer={renderTemplateFormFooter({
          submitLabel: 'Сохранить шаблон',
          onClose: () => setEditTemplateOpen(false),
          onSubmit: () => { void handleEditTemplate(); },
        })}
      >
        {renderTemplateForm()}
      </ModalFrame>

      <DeleteConfirmModal
        open={deleteTemplateOpen && !!activeTemplate}
        title="Удалить шаблон?"
        saving={savingTemplate}
        onCancel={() => setDeleteTemplateOpen(false)}
        onConfirm={() => { void handleDeleteTemplateConfirm(); }}
      />

      {phoneNumbersUserId && (
        <UserPhoneNumbersModal
          accountId={phoneNumbersUserId}
          open={!!phoneNumbersUserId}
          onClose={() => setPhoneNumbersUserId(null)}
        />
      )}
    </div>
  );
}
