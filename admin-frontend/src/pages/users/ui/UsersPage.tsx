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
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { FixedOverlayPortal } from '../../../shared/ui/fixed-overlay-portal/FixedOverlayPortal';

type Props = {
  role: AdminRole;
  employeeId?: string | null;
  onSelectEmployee?: (id: string) => void;
  onBackToUsers?: () => void;
  onOpenDealership?: (id: string) => void;
  onOpenCompanies?: () => void;
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
type UserQuickFilter = 'training' | 'fails' | 'best' | 'comm';
type UserOwnershipFilter = 'all' | 'own' | 'franchised';
type UserEmployeeRow = {
  user: UserAccountItem;
  fullName: string;
  dealershipName: string;
  dealershipNames: string[];
  city: string;
};

const NO_HOLDING_VALUE = '__no_holding__';

const USER_QUICK_FILTERS: { id: UserQuickFilter; label: string }[] = [
  { id: 'training', label: 'Нужно обучение' },
  { id: 'fails', label: 'Провалы' },
  { id: 'best', label: 'Лучшие' },
  { id: 'comm', label: 'Проблемы коммуникации' },
];

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

const COMM_LABELS: Record<UserAccountItem['analytics']['communicationFlag'], string> = {
  ok: 'Ок',
  fillers: 'Паразиты',
  aggression: 'Агрессия',
  profanity: 'Ненормативная',
  'low-engagement': 'Слабая вовлечённость',
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
    title: 'Пользователи и сотрудники',
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
  'user.create': 'Создание пользователей',
  'user.edit': 'Редактирование пользователей',
  'user.delete': 'Удаление пользователей',
  'permission_template.view': 'Просмотр шаблонов прав',
  'permission_template.create': 'Создание шаблонов прав',
  'permission_template.edit': 'Редактирование шаблонов прав',
  'permission_template.assign': 'Назначение шаблонов пользователям',
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
  'ux.users.view': 'Страница “Пользователи”',
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

function commTooltip(flag: UserAccountItem['analytics']['communicationFlag']): string {
  switch (flag) {
    case 'ok': return 'Коммуникация в норме';
    case 'fillers': return 'Обнаружены слова-паразиты в речи';
    case 'aggression': return 'Выявлены признаки агрессии в диалоге';
    case 'profanity': return 'Обнаружена ненормативная лексика';
    case 'low-engagement': return 'Низкая вовлеченность в диалог';
  }
}

function matchesUserQuickFilter(user: UserAccountItem, filter: UserQuickFilter): boolean {
  const analytics = user.analytics;
  switch (filter) {
    case 'training': return analytics.status === 'critical' || analytics.status === 'risk';
    case 'fails': return analytics.failsCount >= 1;
    case 'best': return analytics.aiRating >= 80 && analytics.status === 'norm';
    case 'comm': return analytics.communicationFlag !== 'ok';
  }
}

function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
    </svg>
  );
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
    <div ref={rootRef} style={{ display: 'grid', gap: 6, position: 'relative' }}>
      {props.label && <div style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</div>}
      <button
        type="button"
        className="sa-search-input"
        disabled={props.disabled}
        onClick={() => {
          if (!props.disabled) setOpen((current) => !current);
        }}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          textAlign: 'left',
          paddingLeft: 12,
          cursor: props.disabled ? 'not-allowed' : 'pointer',
          color: selected ? 'var(--sa-text)' : 'var(--sa-text-secondary)',
        }}
      >
        <span>
          <span style={{ display: 'block', fontWeight: selected ? 700 : 500 }}>{selected?.label || props.placeholder}</span>
          {selected?.description && (
            <span style={{ display: 'block', fontSize: 12, color: 'var(--sa-text-secondary)', marginTop: 2 }}>{selected.description}</span>
          )}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--sa-text-secondary)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && !props.disabled && dropdownRect && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            zIndex: 1000,
            top: dropdownRect.bottom + 6,
            left: dropdownRect.left,
            width: dropdownRect.width,
            padding: 10,
            border: '1px solid #E5E7EB',
            borderRadius: 12,
            background: '#fff',
            boxShadow: '0 18px 40px rgba(15,23,42,0.16)',
          }}
        >
          <input
            className="sa-search-input"
            value={query}
            autoFocus
            placeholder="Поиск..."
            onChange={(event) => setQuery(event.target.value)}
            style={{
              marginBottom: 8,
              paddingLeft: 12,
              background: '#F9FAFB',
              borderColor: '#F59E0B',
              boxShadow: '0 0 0 3px rgba(245,158,11,0.12)',
            }}
          />
          <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {props.value && (
              <button
                type="button"
                onClick={() => {
                  props.onChange('');
                  setQuery('');
                  setOpen(false);
                }}
                style={{
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 10px',
                  background: 'transparent',
                  color: 'var(--sa-text-secondary)',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                {props.placeholder}
              </button>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: 10, color: 'var(--sa-text-secondary)', fontSize: 13 }}>Ничего не найдено</div>
            )}
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  props.onChange(option.value);
                  setQuery('');
                  setOpen(false);
                }}
                style={{
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 10px',
                  background: option.value === props.value ? '#FFFBEB' : 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'block', fontWeight: 700 }}>{option.label}</span>
                {option.description && (
                  <span style={{ display: 'block', color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 2 }}>{option.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
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
    <FixedOverlayPortal>
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
    </FixedOverlayPortal>
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
  const dealershipMap = useMemo(() => new Map((props.meta?.dealerships || []).map((item) => [item.id, item])), [props.meta]);

  useEffect(() => {
    if (!props.open) return;
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
    await props.onSubmit(form);
  }

  return (
    <ModalFrame
      title="Новый пользователь"
      subtitle="Создание аккаунта вынесено в отдельное модальное окно."
      open={props.open}
      onClose={props.onClose}
    >
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
        <label className="sa-form-field">
          <span>Email</span>
          <input className="sa-search-input" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>Пароль</span>
          <input type="password" className="sa-search-input" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
        </label>
        <label className="sa-form-field">
          <span>ФИО</span>
          <input className="sa-search-input" value={form.managerFullName} onChange={(event) => setForm((current) => ({ ...current, managerFullName: event.target.value, displayName: event.target.value }))} />
        </label>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Доступ пользователя</div>
          <div style={{ display: 'grid', gap: 10 }}>
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
                <div key={`${index}-${membership.role}-${membership.dealershipId}`} className="sa-card" style={{ padding: 12 }}>
                  <div style={{ display: 'grid', gap: 10 }}>
                    <SearchableSelect
                      label="Права"
                      value={props.canManageGlobalUsers ? membership.role : 'manager'}
                      disabled={!props.canManageGlobalUsers}
                      options={roleOptions}
                      placeholder="Выберите права пользователя"
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
                </div>
              );
            })}
          </div>
        </div>
        <button type="submit" className="sa-btn-primary" disabled={props.saving}>
          {props.saving ? 'Сохраняем...' : 'Создать пользователя'}
        </button>
      </form>
    </ModalFrame>
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

export function UsersPage({ role, employeeId, onSelectEmployee, onBackToUsers, onOpenDealership, onOpenCompanies }: Props) {
  const [tab, setTab] = useState<PageTab>('users');
  const [meta, setMeta] = useState<RbacMeta | null>(null);
  const [users, setUsers] = useState<UserAccountItem[]>([]);
  const [templates, setTemplates] = useState<PermissionTemplateItem[]>([]);
  const [search, setSearch] = useState('');
  const [fullNameFilter, setFullNameFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [holdingFilter, setHoldingFilter] = useState('');
  const [dealershipFilter, setDealershipFilter] = useState('');
  const [ownershipFilter, setOwnershipFilter] = useState<UserOwnershipFilter>('all');
  const [userSortKey, setUserSortKey] = useState<UserSortKey>('aiRating');
  const [userSortDir, setUserSortDir] = useState<SortDir>('desc');
  const [userQuickFilter, setUserQuickFilter] = useState<UserQuickFilter | null>(null);
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
  const [phoneNumbersUserId, setPhoneNumbersUserId] = useState<string | null>(null);

  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [viewTemplateOpen, setViewTemplateOpen] = useState(false);
  const [editTemplateOpen, setEditTemplateOpen] = useState(false);
  const [deleteTemplateOpen, setDeleteTemplateOpen] = useState(false);

  const [userForm, setUserForm] = useState<UserFormState>(EMPTY_USER_FORM);
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
  const detailEmployeeProfileId = detailManagerProfile?.id ?? (detailActionUser ? null : employeeId ?? null);
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
    if (roleFilter) {
      list = list.filter((row) => row.user.memberships.some((membership) => membership.role === roleFilter));
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
    if (userQuickFilter) list = list.filter((row) => matchesUserQuickFilter(row.user, userQuickFilter));

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (userSortKey === 'fullName') cmp = a.fullName.localeCompare(b.fullName, 'ru');
      else if (userSortKey === 'dealershipName') cmp = a.dealershipName.localeCompare(b.dealershipName, 'ru');
      else if (userSortKey === 'status') cmp = a.user.analytics.status.localeCompare(b.user.analytics.status, 'ru');
      else cmp = (a.user.analytics[userSortKey] ?? -Infinity) - (b.user.analytics[userSortKey] ?? -Infinity);
      return userSortDir === 'asc' ? cmp : -cmp;
    });
  }, [dealershipFilter, emailFilter, fullNameFilter, holdingFilter, ownershipFilter, phoneFilter, roleFilter, search, selectedGlobalHoldingId, userQuickFilter, userSortDir, userSortKey, users]);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((item) =>
      [item.name, item.description || '', ...item.permissions].join(' ').toLowerCase().includes(q),
    );
  }, [templates, search]);

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
    fillUserForm(user);
    setEditDeleteConfirm(false);
    setEditUserOpen(true);
  }

  function fillUserForm(user: UserAccountItem) {
    const firstProfile = user.managerProfiles[0];
    setUserForm({
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
    if (!activeUserId) throw new Error('Пользователь не выбран.');
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
      setEditDeleteConfirm(false);
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
      setEditDeleteConfirm(false);
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

  function handleUserSort(key: UserSortKey) {
    if (userSortKey === key) {
      setUserSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setUserSortKey(key);
    setUserSortDir(key === 'fullName' || key === 'dealershipName' || key === 'status' ? 'asc' : 'desc');
  }

  function renderUserForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string, options?: { showStatus?: boolean }) {
    const showStatus = options?.showStatus ?? true;
    return (
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
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
          <label className="sa-form-field">
            <span>Состояние аккаунта</span>
            <select className="sa-select" value={userForm.status} onChange={(event) => setUserForm((current) => ({ ...current, status: event.target.value }))}>
              <option value="active">Аккаунт включен</option>
              <option value="invited">Приглашение отправлено</option>
              <option value="disabled">Аккаунт выключен</option>
            </select>
          </label>
        )}
        <div>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Доступ пользователя</div>
          <div style={{ display: 'grid', gap: 10 }}>
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
                <div key={`${index}-${membership.role}-${membership.dealershipId}`} className="sa-card" style={{ padding: 12 }}>
                  <div style={{ display: 'grid', gap: 10 }}>
                    <SearchableSelect
                      label="Права"
                      value={canManageGlobalUsers ? membership.role : 'manager'}
                      disabled={!canManageGlobalUsers}
                      options={roleOptions}
                      placeholder="Выберите права пользователя"
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
                </div>
              );
            })}
          </div>
        </div>
        <div className="sa-holdings-form-footer">
          <div className="sa-holdings-form-footer-left">
            {editDeleteConfirm ? (
              <>
                <span className="sa-holdings-form-delete-hint">
                  Удалить <strong>{activeUser?.displayName || activeUser?.email}</strong>?
                </span>
                <button type="button" className="sa-btn-danger" onClick={() => void handleDeleteUserConfirm()} disabled={savingUser}>
                  {savingUser ? 'Удаляем...' : 'Удалить'}
                </button>
                <button type="button" className="sa-btn-outline" onClick={() => setEditDeleteConfirm(false)} disabled={savingUser}>
                  Нет
                </button>
              </>
            ) : (
              <button type="button" className="sa-btn-danger" onClick={() => setEditDeleteConfirm(true)}>
                Удалить пользователя
              </button>
            )}
          </div>
          <div className="sa-holdings-form-footer-right">
            <button type="button" className="sa-btn-outline" onClick={() => { setEditUserOpen(false); setEditDeleteConfirm(false); }}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={savingUser}>
              {savingUser ? 'Сохраняем...' : submitLabel}
            </button>
          </div>
        </div>
      </form>
    );
  }

  function renderTemplateForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string) {
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
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-end', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700 }}>Права доступа</div>
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 4 }}>
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
            className="sa-search-input"
            placeholder="Найти право: звонки, пользователи, дашборд..."
            value={permissionSearch}
            onChange={(event) => setPermissionSearch(event.target.value)}
            style={{ marginBottom: 12 }}
          />

          <div style={{ display: 'grid', gap: 12, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            {groupedTemplatePermissions.length === 0 && (
              <div className="sa-card" style={{ padding: 14, color: 'var(--sa-text-secondary)' }}>
                Ничего не найдено. Попробуйте другой запрос.
              </div>
            )}

            {groupedTemplatePermissions.map((group) => {
              const groupKeys = group.permissions.map((permission) => permission.key);
              const selectedInGroup = groupKeys.filter((key) => templateForm.permissions.includes(key)).length;
              const allSelected = selectedInGroup === groupKeys.length && groupKeys.length > 0;

              return (
                <section key={group.id} className="sa-card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{group.title}</div>
                      <div style={{ color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 4 }}>{group.description}</div>
                    </div>
                    <button
                      type="button"
                      className="sa-btn-text"
                      onClick={() => setGroupPermissions(groupKeys, !allSelected)}
                    >
                      {allSelected ? 'Снять раздел' : 'Выбрать раздел'}
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span className="sa-metric-chip">{selectedInGroup}/{groupKeys.length} выбрано</span>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {group.permissions.map((permission) => {
                      const checked = templateForm.permissions.includes(permission.key);
                      return (
                        <label
                          key={permission.key}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '18px 1fr',
                            gap: 10,
                            alignItems: 'flex-start',
                            padding: '10px 12px',
                            border: `1px solid ${checked ? '#F59E0B' : '#E5E7EB'}`,
                            borderRadius: 10,
                            background: checked ? '#FFFBEB' : '#fff',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePermission(permission.key)}
                            style={{ marginTop: 3 }}
                          />
                          <span>
                            <span style={{ display: 'block', fontWeight: 700 }}>{permissionLabel(permission.key)}</span>
                            <span style={{ display: 'block', color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 3 }}>
                              {permission.description}
                            </span>
                            <span style={{ display: 'block', color: '#9CA3AF', fontSize: 11, marginTop: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                              {permission.key}
                            </span>
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
        <button type="submit" className="sa-btn-danger" disabled={savingTemplate}>
          {savingTemplate ? 'Сохраняем...' : submitLabel}
        </button>
      </form>
    );
  }

  return (
    <div>
      {employeeId ? (
        null
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
          <h1 className="sa-page-title" style={{ marginBottom: 0 }}>Пользователи</h1>
          <select
            className="sa-select"
            value={selectedGlobalHoldingId}
            onChange={(event) => setSelectedGlobalHoldingId(event.target.value)}
            disabled={loading || (meta?.holdings || []).length === 0}
            style={{ minWidth: 220 }}
            title="Глобальный фильтр по компаниям"
          >
            {(meta?.holdings || []).length === 0 ? <option value="">Нет компаний</option> : null}
            {(meta?.holdings || []).map((holding) => (
              <option key={holding.id} value={holding.id}>{holding.name}</option>
            ))}
          </select>
        </div>
      )}

      {error && <div className="sa-card" style={{ marginBottom: 16, color: '#991B1B', background: '#FEF2F2' }}>{error}</div>}
      {notice && <div className="sa-card" style={{ marginBottom: 16, color: '#166534', background: '#F0FDF4' }}>{notice}</div>}

      {employeeId && loading ? (
        <div className="sa-card" style={{ padding: 24 }}>
          <div className="sa-meta">Загрузка сотрудника...</div>
        </div>
      ) : employeeId && detailEmployeeProfileId ? (
        <EmployeeDetail
          employeeId={detailEmployeeProfileId}
          onBack={() => onBackToUsers?.()}
          onOpenDealership={onOpenDealership}
          onOpenCompanies={onOpenCompanies}
          detailOverride={detailActionUser ? {
            fullName: userFullName(detailActionUser),
            dealershipName: userScopeLabel(detailActionUser),
            city: detailActionUser.managerProfiles[0]?.holdingName || detailActionUser.memberships[0]?.holdingName || '',
          } : undefined}
          headerRight={(
            <select
              className="sa-select"
              value={selectedGlobalHoldingId}
              onChange={(event) => setSelectedGlobalHoldingId(event.target.value)}
              disabled={loading || (meta?.holdings || []).length === 0}
              style={{ minWidth: 220 }}
              title="Глобальный фильтр по компаниям"
            >
              {(meta?.holdings || []).length === 0 ? <option value="">Нет компаний</option> : null}
              {(meta?.holdings || []).map((holding) => (
                <option key={holding.id} value={holding.id}>{holding.name}</option>
              ))}
            </select>
          )}
          actionButtons={detailActionUser && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              <button type="button" className="sa-btn-outline" onClick={() => openEditUser(detailActionUser)}>
                <EditIcon />
                Редактировать
              </button>
              <button type="button" className="sa-btn-outline" onClick={() => setPhoneNumbersUserId(detailActionUser.id)}>
                <PhoneIcon />
                Номера телефонов
              </button>
            </div>
          )}
        />
      ) : employeeId ? (
        <div className="sa-card" style={{ padding: 24 }}>
          <button type="button" className="sa-btn-text" onClick={() => onBackToUsers?.()} style={{ marginBottom: 16 }}>
            Назад к пользователям
          </button>
          <h2 className="sa-card-heading">Профиль менеджера не привязан</h2>
          <p className="sa-meta" style={{ margin: 0 }}>
            У этого web-аккаунта пока нет профиля для звонков. Добавьте точку в назначениях пользователя, чтобы открыть аналитику.
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
          Списки пользователей
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
          <div className="sa-toolbar">
            <div className="sa-toolbar-split sa-holdings-toolbar">
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
                <button type="button" className="sa-btn-border-only" onClick={() => setShowUserFilters((current) => !current)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                  </svg>
                  Фильтры
                </button>
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
                  Новый пользователь
                </button>
              </div>
            </div>
            <div className="sa-toolbar-chips">
              {USER_QUICK_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`sa-chip ${userQuickFilter === filter.id ? 'sa-chip-active' : ''}`}
                  onClick={() => setUserQuickFilter((current) => (current === filter.id ? null : filter.id))}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {showUserFilters && (
            <div className="sa-filters-panel">
              <div className="sa-filter-group">
                <span className="sa-filter-label">Данные пользователя:</span>
                <div className="sa-filter-options" style={{ alignItems: 'stretch' }}>
                  <input className="sa-input" style={{ minWidth: 0, flex: '1 1 180px' }} value={fullNameFilter} onChange={(event) => setFullNameFilter(event.target.value)} placeholder="ФИО" />
                  <input className="sa-input" style={{ minWidth: 0, flex: '1 1 180px' }} value={emailFilter} onChange={(event) => setEmailFilter(event.target.value)} placeholder="Электронная почта" />
                  <input className="sa-input" style={{ minWidth: 0, flex: '1 1 160px' }} value={phoneFilter} onChange={(event) => setPhoneFilter(event.target.value)} placeholder="Телефон" />
                </div>
              </div>

              <div className="sa-filter-group">
                <span className="sa-filter-label">Роль:</span>
                <div className="sa-filter-options">
                  {(meta?.roles || []).map((item) => (
                    <label key={item} className="sa-filter-check">
                      <input
                        type="checkbox"
                        checked={roleFilter === item}
                        onChange={() => setRoleFilter((current) => (current === item ? '' : item))}
                      />
                      {roleLabel(item)}
                    </label>
                  ))}
                </div>
              </div>

              <div className="sa-filter-group">
                <span className="sa-filter-label">Компания:</span>
                <div className="sa-filter-options" style={{ alignItems: 'stretch' }}>
                  <div style={{ minWidth: 0, flex: '1 1 260px', maxWidth: 420 }}>
                    <SearchableSelect
                      value={holdingFilter}
                      options={holdingFilterOptions}
                      placeholder="Все компании"
                      onChange={setHoldingFilter}
                    />
                  </div>
                </div>
              </div>

              <div className="sa-filter-group">
                <span className="sa-filter-label">Точка:</span>
                <div className="sa-filter-options" style={{ alignItems: 'stretch' }}>
                  <div style={{ minWidth: 0, flex: '1 1 260px', maxWidth: 420 }}>
                    <SearchableSelect
                      value={dealershipFilter}
                      options={dealershipFilterOptions}
                      placeholder="Все точки"
                      onChange={setDealershipFilter}
                    />
                  </div>
                </div>
              </div>

              <div className="sa-filter-group">
                <span className="sa-filter-label">Франшиза / Свои:</span>
                <div className="sa-filter-options">
                  {[
                    { value: 'own' as UserOwnershipFilter, label: 'Свои' },
                    { value: 'franchised' as UserOwnershipFilter, label: 'Франшиза' },
                  ].map((option) => (
                    <label key={option.value} className="sa-filter-check">
                      <input
                        type="checkbox"
                        checked={ownershipFilter === option.value}
                        onChange={() => setOwnershipFilter((current) => (current === option.value ? 'all' : option.value))}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="sa-filter-reset"
                onClick={() => {
                  setFullNameFilter('');
                  setEmailFilter('');
                  setPhoneFilter('');
                  setRoleFilter('');
                  setHoldingFilter('');
                  setDealershipFilter('');
                  setOwnershipFilter('all');
                  setUserQuickFilter(null);
                }}
              >
                Сбросить фильтры
              </button>
            </div>
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
                <col className="sa-col-comm" />
                <col className="sa-col-mistake" />
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
                  <th>Коммуникация</th>
                  <th>ТОП-ошибка</th>
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
                  <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Загрузка...</td></tr>
                ) : userEmployeeRows.length === 0 ? (
                  <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>
                    Нет пользователей по выбранным фильтрам
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
                        <td title={commTooltip(analytics.communicationFlag)}>
                          {COMM_LABELS[analytics.communicationFlag]}
                        </td>
                        <td><span className="sa-top-mistake" title={analytics.topMistakeLabel}>{analytics.topMistakeLabel}</span></td>
                        <td><span className={statusBadgeClass(analytics.status)}>{USER_ANALYTICS_STATUS_LABELS[analytics.status]}</span></td>
                        <td className="sa-holdings-actions-cell" onClick={(event) => event.stopPropagation()}>
                          <div>
                            <button
                              type="button"
                              className="sa-btn-icon sa-btn-brutal-3d-icon"
                              onClick={() => actionUser && setPhoneNumbersUserId(actionUser.id)}
                              aria-label="Номера телефонов"
                              title="Номера телефонов"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="sa-btn-icon sa-btn-brutal-3d-icon"
                              onClick={() => actionUser && openEditUser(actionUser)}
                              aria-label="Редактировать"
                              title="Редактировать"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                              </svg>
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
              <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Нет пользователей по выбранным фильтрам</div>
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
                      <span>{COMM_LABELS[analytics.communicationFlag]}</span>
                      <span className={statusBadgeClass(analytics.status)}>{USER_ANALYTICS_STATUS_LABELS[analytics.status]}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="sa-btn-icon sa-btn-brutal-3d-icon"
                        onClick={() => actionUser && setPhoneNumbersUserId(actionUser.id)}
                        aria-label="Номера телефонов"
                        title="Номера телефонов"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="sa-btn-icon sa-btn-brutal-3d-icon"
                        onClick={() => actionUser && openEditUser(actionUser)}
                        aria-label="Редактировать"
                        title="Редактировать"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                        </svg>
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
              <button type="button" className="sa-btn-danger" onClick={() => { resetTemplateForm(); setPermissionSearch(''); setCreateTemplateOpen(true); }}>
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
                        <span key={permission} className="sa-metric-chip">{permissionLabel(permission)}</span>
                      ))}
                      {template.isSystem && <span className="sa-metric-chip">Системный</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
                    <button type="button" className="sa-btn-outline" onClick={() => { setActiveTemplateId(template.id); setViewTemplateOpen(true); }}>
                      Просмотр
                    </button>
                    <button
                      type="button"
                      className="sa-btn-outline"
                      disabled={template.isSystem}
                      title={template.isSystem ? 'Системные шаблоны редактируются в коде.' : undefined}
                      onClick={() => {
                        if (template.isSystem) return;
                        setActiveTemplateId(template.id);
                        fillTemplateForm(template);
                        setPermissionSearch('');
                        setEditTemplateOpen(true);
                      }}
                    >
                      Редактирование
                    </button>
                    {!template.isSystem && (
                      <button type="button" className="sa-btn-danger" onClick={() => { setActiveTemplateId(template.id); setDeleteTemplateOpen(true); }}>
                        Удалить
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
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
        title="Редактировать пользователя"
        subtitle="Изменение пользователя выполняется через отдельное модальное окно."
        open={editUserOpen}
        onClose={() => { setEditUserOpen(false); setEditDeleteConfirm(false); }}
      >
        {renderUserForm(handleEditUser, 'Сохранить пользователя')}
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
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Права доступа</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {activeTemplatePermissionGroups.map((group) => {
                  const isOpen = openTemplatePermissionGroups.includes(group.id);
                  return (
                    <div key={group.id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenTemplatePermissionGroups((current) =>
                            current.includes(group.id)
                              ? current.filter((item) => item !== group.id)
                              : [...current, group.id],
                          )
                        }
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          padding: '12px 14px',
                          border: 'none',
                          background: '#F9FAFB',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span>
                          <span style={{ display: 'block', fontWeight: 800 }}>{group.title}</span>
                          <span style={{ display: 'block', color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 3 }}>
                            {group.description}
                          </span>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                          <span className="sa-metric-chip">{group.selected.length}/{group.total}</span>
                          <span aria-hidden="true" style={{ color: 'var(--sa-text-secondary)', fontSize: 12 }}>
                            {isOpen ? '▲' : '▼'}
                          </span>
                        </span>
                      </button>

                      {isOpen && (
                        <div style={{ display: 'grid', gap: 8, padding: 12 }}>
                          {group.selected.map((permission) => (
                            <div key={permission.key} style={{ padding: '10px 12px', border: '1px solid #EEF2F7', borderRadius: 10 }}>
                              <div style={{ fontWeight: 800 }}>{permissionLabel(permission.key)}</div>
                              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 12, marginTop: 4 }}>
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
                  <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>В шаблоне пока нет выбранных прав.</div>
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
