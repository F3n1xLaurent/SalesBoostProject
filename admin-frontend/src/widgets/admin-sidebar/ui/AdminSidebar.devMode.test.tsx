import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSidebar, type AdminRole } from './AdminSidebar';

const mode = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../entities/session/model/useDevMode', () => ({
  useDevMode: (role: string) => ({ devMode: role === 'super' && mode.enabled }),
}));
vi.mock('./DevModeSwitch', () => ({ DevModeSwitch: () => null }));
vi.mock('../../../shared/ui/icons/LetsIcon', () => ({ LetsIcon: () => null }));
vi.mock('../../../shared/ui/logo/SalsaLogo', () => ({ SalsaLogo: () => null }));
beforeEach(() => { mode.enabled = false; });

function renderSidebar(role: AdminRole) {
  return renderToStaticMarkup(<AdminSidebar role={role} activeTab="dashboard" profileName="Admin"
    allowedRoles={[role]} onTab={() => {}} onRoleChange={() => {}} onLogout={() => {}} />);
}

describe('testing menu in dev mode', () => {
  it('hides Testing by default and reveals it only while dev mode is enabled', () => {
    expect(renderSidebar('super')).not.toContain('Тестирование');
    mode.enabled = true;
    expect(renderSidebar('super')).toContain('Тестирование');
    mode.enabled = false;
    expect(renderSidebar('super')).not.toContain('Тестирование');
  });

  it.each(['company', 'dealer', 'staff'] as const)('keeps Testing hidden from %s even with dev mode stored', (role) => {
    mode.enabled = true;
    expect(renderSidebar(role)).not.toContain('Тестирование');
  });
});
