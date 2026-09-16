import { FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FlowButton } from './FlowButton';
import { SalsaLogo } from '../../../shared/ui/logo/SalsaLogo';
import { ShaderBackground } from './ShaderBackground';

function GridEnds() {
  return (
    <>
      <span className="sl-x sl-x-l" aria-hidden>+</span>
      <span className="sl-x sl-x-r" aria-hidden>+</span>
    </>
  );
}

const PHONE_NATIONAL_LEN = 10;

function parseNationalPhoneDigits(input: string): string {
  const trimmed = input.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+7') || trimmed.startsWith('+')) {
    if (digits.startsWith('7')) digits = digits.slice(1);
  } else if (digits.length >= 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    digits = digits.slice(1);
  }
  return digits.slice(0, PHONE_NATIONAL_LEN);
}

function formatNationalPhone(national: string): string {
  const a = national.slice(0, 3);
  const b = national.slice(3, 6);
  const c = national.slice(6, 8);
  const d = national.slice(8, 10);
  let out = a;
  if (b) out += ` ${b}`;
  if (c) out += `-${c}`;
  if (d) out += `-${d}`;
  return out;
}

function formatPhoneFieldValue(national: string, focused: boolean): string {
  if (!national && !focused) return '';
  const rest = formatNationalPhone(national);
  return rest ? `+7 ${rest}` : '+7 ';
}

export function DemoLeadForm() {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [comment, setComment] = useState('');
  const [pdnConsent, setPdnConsent] = useState(false);
  const [adsConsent, setAdsConsent] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [website, setWebsite] = useState('');
  const submissionKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    if (!name.trim() || !company.trim() || phoneDigits.length !== PHONE_NATIONAL_LEN || !pdnConsent) {
      setSubmitError('Проверьте обязательные поля и согласие на обработку данных.');
      return;
    }

    const payload = {
      name: name.trim(),
      company: company.trim(),
      phone: `+7${phoneDigits}`,
      comment: comment.trim(),
      personalDataConsent: pdnConsent,
      marketingConsent: adsConsent,
      website,
    };
    const fingerprint = JSON.stringify(payload);
    if (submissionKeyRef.current?.fingerprint !== fingerprint) {
      const key = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      submissionKeyRef.current = { fingerprint, key };
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/public/landing-leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': submissionKeyRef.current.key,
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(result?.error || 'Не удалось отправить заявку. Попробуйте ещё раз.');
      }
      setSent(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Не удалось отправить заявку. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="sl-lead-done" role="status" aria-live="polite">
        <strong>Заявка отправлена</strong>
        <p>Свяжемся, чтобы согласовать время демо</p>
      </div>
    );
  }

  return (
    <form className="sl-lead-form" onSubmit={onSubmit}>
      <label className="sl-lead-field">
        <span>Имя</span>
        <input
          className="sl-lead-input"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          maxLength={100}
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>Компания</span>
        <input
          className="sl-lead-input"
          type="text"
          autoComplete="organization"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          minLength={2}
          maxLength={160}
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>Телефон</span>
        <input
          className="sl-lead-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+7 999 000-00-00"
          value={formatPhoneFieldValue(phoneDigits, phoneFocused)}
          onFocus={() => setPhoneFocused(true)}
          onBlur={() => setPhoneFocused(false)}
          onChange={(e) => setPhoneDigits(parseNationalPhoneDigits(e.target.value))}
          aria-label="Номер телефона"
          required
        />
      </label>
      <label className="sl-lead-field">
        <span>
          Комментарий <em>необязательно</em>
        </span>
        <textarea
          className="sl-lead-area"
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
        />
      </label>
      <label className="sl-lead-honeypot" aria-hidden="true">
        Сайт
        <input
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          autoComplete="off"
          tabIndex={-1}
        />
      </label>
      <div className="sl-lead-consents">
        <label className="sl-lead-check">
          <input
            type="checkbox"
            checked={pdnConsent}
            onChange={(e) => setPdnConsent(e.target.checked)}
            required
          />
          <span>
            Даю{' '}
            <Link to="/landing/consent" target="_blank" rel="noopener noreferrer">
              согласие на обработку персональных данных
            </Link>
            {' '}и принимаю{' '}
            <Link to="/landing/privacy" target="_blank" rel="noopener noreferrer">
              политику обработки персональных данных
            </Link>
          </span>
        </label>
        <label className="sl-lead-check">
          <input
            type="checkbox"
            checked={adsConsent}
            onChange={(e) => setAdsConsent(e.target.checked)}
          />
          <span>
            Согласен получать{' '}
            <Link to="/landing/marketing" target="_blank" rel="noopener noreferrer">
              информационные и рекламные сообщения
            </Link>
          </span>
        </label>
      </div>
      <div className="sl-lead-actions">
        {submitError ? <p className="sl-lead-error" role="alert">{submitError}</p> : null}
        <FlowButton
          text={submitting ? 'Отправляем…' : 'Записаться на демо'}
          type="submit"
          variant="solid"
          disabled={submitting}
        />
      </div>
    </form>
  );
}

type FinalDemoBlockProps = {
  /** Landing: show secondary CTA to try-call. Demo stand: hide it. */
  showCallCta?: boolean;
  id?: string;
  className?: string;
};

export function FinalDemoBlock({
  showCallCta = true,
  id = 'demo',
  className = '',
}: FinalDemoBlockProps) {
  const rootClass = [
    'sl-sec',
    'sl-final',
    'sl-reveal',
    'is-in',
    !showCallCta ? 'sl-final--lead-only' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <section className={rootClass} id={id}>
      <div className="sl-final-shot sl-demo-stage sl-reveal sl-reveal-delay-1 is-in">
        <ShaderBackground className="sl-final-shot-canvas sl-hero-shot-shader" variant="plasma" />
        <div className="sl-final-shot-grid">
          <div className="sl-final-shot-copy">
            <div>
              <SalsaLogo className="sl-final-logo" />
              <h2 className="sl-final-title">
                Протестируйте
                <br />
                на своей сети
              </h2>
              <p className="sl-final-sub">
                За 30 минут покажем весь цикл на вашем бизнесе:
                продажи, поставки, сервис, кредит, стандарты, скрипты, результаты
              </p>
            </div>
            {showCallCta ? (
              <FlowButton
                text="Получить демо-звонок сейчас"
                href="#try"
                className="sl-final-cta-desktop"
              />
            ) : null}
          </div>
          <div className="sl-final-card">
            <DemoLeadForm />
          </div>
          {showCallCta ? (
            <div className="sl-final-cta-mobile">
              <FlowButton text="Получить демо-звонок сейчас" href="#try" />
            </div>
          ) : null}
        </div>
      </div>
      <GridEnds />
    </section>
  );
}
