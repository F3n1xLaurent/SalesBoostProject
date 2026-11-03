import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DevModeSwitch } from './DevModeSwitch';

describe('dev mode switch visibility', () => {
  it('shows an accessible switch, off by default, to superadmins', () => {
    const html = renderToStaticMarkup(<DevModeSwitch role="super" />);
    expect(html).toContain('Dev-режим');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });
  it.each(['company', 'dealer', 'staff'] as const)('does not render for %s', (role) => {
    expect(renderToStaticMarkup(<DevModeSwitch role={role} />)).toBe('');
  });
});
