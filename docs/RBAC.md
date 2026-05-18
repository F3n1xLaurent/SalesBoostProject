# RBAC

Проект переходит от Telegram-first admin access к account-first RBAC.

## Роли

- `platform_superadmin`
- `holding_admin`
- `dealership_admin`
- `manager`

Роль сама по себе не даёт полный доступ без scope:

- `platform_superadmin` -> platform scope
- `holding_admin` -> конкретный `holdingId`
- `dealership_admin` -> конкретный `dealershipId`
- `manager` -> собственный профиль / тренировки и, при необходимости, свой `dealershipId`

## Permission naming

Права заданы в `src/auth/permissions.ts` в виде `resource.action`.

Примеры:

- `dealer.view`
- `dealer.edit`
- `manager.view`
- `manager.edit`
- `audit.view`
- `audit.run`
- `call.start`
- `call_batch.manage`

## Основные группы permission

- `dashboard.view`, `dashboard.platform.view`, `dashboard.holding.view`, `dashboard.dealership.view`
- `analytics.view`, `analytics.export`
- `holding.view`, `holding.edit`
- `dealer.view`, `dealer.edit`
- `manager.view`, `manager.edit`
- `audit.view`, `audit.export`, `audit.run`, `audit.manage`
- `call.view`, `call.start`
- `call_batch.view`, `call_batch.create`, `call_batch.manage`
- `training.view`, `training.run`, `training.review`
- `profile.view`, `profile.edit`
- `settings.view`, `settings.edit`, `settings.platform.view`, `settings.holding.view`, `settings.dealership.view`, `settings.manager.view`
- `expenses.view`, `expenses.export`
- `voice.diagnostics`
- UX-блоки админки: `ux.*`

## UX permissions

Фронт сейчас открывает разные страницы по роли. Для этих блоков добавлены отдельные permission keys, чтобы доступ можно было задавать через RBAC, а не только через `super/company/dealer/staff`.

- Суперадмин: `dashboard.platform.view`, `ux.holdings.view`, `ux.phone_number_types.view`, `ux.permission_templates.view`
- Холдинг: `dashboard.holding.view`, `ux.dealerships.list`, `ux.dealerships.detail`, `ux.users.view`, `ux.employees.*`, `ux.audits.*`, `ux.analytics.holding.view`
- Автосалон: `dashboard.dealership.view`, `ux.dealership_workspace.overview`, `ux.dealership_workspace.calls`, `ux.dealership_workspace.employees`, `ux.dealership_workspace.team`
- Менеджер: `ux.staff_workspace.profile`, `ux.staff_workspace.trainer`, `settings.manager.view`

## Role presets

Presets заданы в `ROLE_PERMISSION_PRESETS`:

- `platform_superadmin` -> все permission
- `holding_admin` -> холдинг, автосалоны, сотрудники, проверки, звонки, аналитика, расходы
- `dealership_admin` -> автосалон, сотрудники, проверки, звонки, аналитика
- `manager` -> профиль и тренировки

## Системные шаблоны прав

Системные шаблоны заданы в `SYSTEM_PERMISSION_TEMPLATES` и синхронизируются в БД как `PermissionTemplate.isSystem = true`.

- `Суперадмин платформы` — все permissions.
- `Администратор холдинга` — дашборд холдинга, автосалоны, сотрудники, пользователи-менеджеры, проверки, аналитика, расходы и настройки холдинга.
- `Администратор автосалона` — рабочее пространство автосалона: салон, звонки, сотрудники, команда, проверки и настройки.
- `Менеджер автосалона` — профиль, тренажёр, результаты тренировок и настройки аккаунта.
- `Аудитор звонков` — просмотр звонков, проверок, batch-проверок и аналитики.
- `Оператор проверок` — запуск и управление одиночными и batch-проверками.
- `Администратор пользователей` — web-аккаунты, роли, назначения и шаблоны прав.

## UI / API mapping

В коде также заданы:

- `SUPER_ADMIN_TAB_PERMISSIONS` -> permission для вкладок админки
- `ADMIN_API_PERMISSION_MAP` -> базовый mapping API endpoint -> required permission

Это foundation. Следующий шаг — подключить middleware `requirePermission(...)` к `server.ts` и скрывать вкладки/кнопки во фронте по permission.
