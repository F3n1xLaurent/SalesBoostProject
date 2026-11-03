import React from 'react';
import type { AdminRole } from '../../../entities/session/model/types';
import { useDevMode } from '../../../entities/session/model/useDevMode';

export function DevModeSwitch({ role }: { role: AdminRole }) {
  const { devMode, setDevMode } = useDevMode(role);
  if (role !== 'super') return null;
  return (
    <div className="sa-sidebar-dev-section">
      <button type="button" role="switch" aria-checked={devMode}
        className="sa-sidebar-profile-menu-item sa-sidebar-dev-toggle"
        onClick={() => setDevMode(!devMode)}>
        <span>Dev-режим</span>
        <span className="sa-sidebar-dev-switch" aria-hidden="true"><span /></span>
      </button>
    </div>
  );
}
