import { Icon } from '@iconify/react';

type Props = {
  name: string;
  size?: number;
  className?: string;
  /** Slightly thicker outline for sidebar / emphasis */
  bold?: boolean;
};

/** Icons from Lets Icons pack (Leonid Tsvetkov) — Figma Free Icon Pack 1800+ */
export function LetsIcon({ name, size = 20, className, bold = false }: Props) {
  return (
    <Icon
      icon={`lets-icons:${name}`}
      width={size}
      height={size}
      className={[className, bold ? 'sa-icon-bold' : ''].filter(Boolean).join(' ') || undefined}
      aria-hidden
    />
  );
}
