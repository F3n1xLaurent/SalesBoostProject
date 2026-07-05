import React, { useState } from 'react';
import { useUnit } from 'effector-react';
import sidebarLogo from '../../../assets/logo.png';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import { $auth, loginFx } from '../model/model';

export function LoginPage() {
  const auth = useUnit($auth);
  const pending = useUnit(loginFx.pending);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await loginFx({ email: email.trim().toLowerCase(), password });
  };

  return (
    <div className="theme-brutal sa-login-shell">
      <div className="sa-login-card sa-page-enter">
        <div className="sa-login-brand">
          <img src={sidebarLogo} alt="Sales Boost" className="sa-sidebar-brand-logo" />
        </div>

        <h1 className="sa-page-title sa-login-title">Вход в систему</h1>
        <p className="sa-login-subtitle">Введите email и пароль для доступа к панели</p>

        <form className="sa-login-form" onSubmit={submit}>
          <label className="sa-login-field">
            <span>Email</span>
            <input
              type="email"
              className="sa-input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label className="sa-login-field">
            <span>Пароль</span>
            <input
              type="password"
              className="sa-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {auth.status === 'guest' && auth.error && (
            <div className="sa-login-error" role="alert">
              {auth.error}
            </div>
          )}

          <button type="submit" className="sa-btn-brutal-3d sa-login-submit" disabled={pending}>
            {pending ? 'Вход…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
