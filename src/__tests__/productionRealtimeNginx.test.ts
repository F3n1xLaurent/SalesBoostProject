import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production call-plan audio through nginx', () => {
  const source = readFileSync(path.resolve('nginx.prod.conf.example'), 'utf8');
  const appServer = source.slice(source.indexOf('# Application site:'));
  const location = appServer.match(/location = \/voice\/openai-realtime \{([^}]+)\}/)?.[1] ?? '';

  it('has a dedicated app-host WebSocket location instead of HTTP/SPA fallback', () => {
    expect(appServer).toContain('server_name app.salsa-sales.ru;');
    expect(location).toContain('proxy_pass http://salesboost_backend;');
    expect(location).toContain('proxy_http_version 1.1;');
    expect(location).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(location).toContain('proxy_set_header Connection $connection_upgrade;');
    expect(source).toContain('map $http_upgrade $connection_upgrade');
  });

  it('supports long audio streams without logging private query tokens', () => {
    expect(location).toContain('proxy_read_timeout 3600s;');
    expect(location).toContain('proxy_send_timeout 3600s;');
    expect(location).toContain('proxy_buffering off;');
    expect(location).toContain('access_log off;');
  });
});
