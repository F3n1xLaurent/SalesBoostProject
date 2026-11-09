type Template = { id: string; name: string; isSystem: boolean; description?: string | null };
const DEFAULT_TEMPLATE_NAMES: Record<string, string> = {
  platform_superadmin: 'Суперадмин платформы',
  holding_admin: 'Администратор холдинга',
  dealership_admin: 'Администратор автосалона',
  manager: 'Менеджер автосалона',
};

export function defaultPermissionTemplateId(role: string, templates: readonly Template[]): string {
  return templates.find(template => template.isSystem && template.name === DEFAULT_TEMPLATE_NAMES[role])?.id ?? '';
}

export function customUserRoleOptions(templates: readonly Template[]) {
  return templates.filter(template => !template.isSystem).map(template => ({
    value: `template:${template.id}`, label: template.name, description: template.description || undefined,
  }));
}

export function selectedUserRole(role: string, ids: readonly string[], templates: readonly Template[]): string {
  const custom = ids.find(id => templates.some(template => template.id === id && !template.isSystem));
  return custom ? `template:${custom}` : role;
}

/** The membership carries organizational scope; the single assignment carries
 * the selected role's template. Custom-role scope is supplied by the caller. */
export function resolveUserRole(value: string, templates: readonly Template[], customBaseRole: string) {
  if (!value) return { role: '', templateIds: [] };
  if (value.startsWith('template:')) {
    const template = templates.find(item => item.id === value.slice('template:'.length) && !item.isSystem);
    if (!template) throw new Error('Выбранный шаблон прав не найден. Обновите список ролей.');
    return { role: customBaseRole, templateIds: [template.id] };
  }
  if (!Object.hasOwn(DEFAULT_TEMPLATE_NAMES, value)) throw new Error('Выберите роль пользователя.');
  const id = defaultPermissionTemplateId(value, templates);
  return { role: value, templateIds: id ? [id] : [] };
}
