import React, { useState } from 'react';
import { Button, Card, CardBody, Input } from '@heroui/react';
import { useUnit } from 'effector-react';
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
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background:
          'radial-gradient(circle at top left, rgba(251,191,36,0.18), transparent 26%), linear-gradient(160deg, #0f172a 0%, #111827 46%, #1f2937 100%)',
      }}
    >
      <Card
        shadow="lg"
        style={{
          width: '100%',
          maxWidth: 440,
          borderRadius: 28,
          background: 'rgba(255,255,255,0.96)',
          boxShadow: '0 22px 60px rgba(15,23,42,0.28)',
        }}
      >
        <CardBody style={{ padding: 32, display: 'grid', gap: 20 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#9A3412', marginBottom: 12 }}>
              Sales Boost
            </div>
            <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.05, color: '#111827' }}>Вход в систему</h1>
            <p style={{ margin: '12px 0 0', color: '#4B5563', fontSize: 14 }}>
              Авторизация по email и паролю. Токен хранится локально в браузере.
            </p>
          </div>

          <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
            <Input
              type="email"
              label="Email"
              value={email}
              onValueChange={setEmail}
              variant="bordered"
              isRequired
            />
            <Input
              type="password"
              label="Пароль"
              value={password}
              onValueChange={setPassword}
              variant="bordered"
              isRequired
            />

            {auth.status === 'guest' && auth.error && (
              <div
                style={{
                  fontSize: 13,
                  color: '#B91C1C',
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 14,
                  padding: '10px 12px',
                }}
              >
                {auth.error}
              </div>
            )}

            <Button
              type="submit"
              color="warning"
              size="lg"
              isLoading={pending}
              style={{ fontWeight: 700 }}
            >
              Войти
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
