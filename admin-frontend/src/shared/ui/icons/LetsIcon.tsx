import { Icon } from '@iconify/react';

type Props = {
  name: string;
  size?: number;
  className?: string;
  /** Slightly thicker outline for sidebar / emphasis */
  bold?: boolean;
  /** Uniform stroke width for outline icons (e.g. sidebar nav) */
  strokeWidth?: number;
};

/**
 * Some plain Lets Icons names ship as filled glyphs; map to outline twins
 * so consumers can keep semantic names like `shop` without suffixes.
 */
const OUTLINE_ALIASES: Record<string, string> = {
  shop: 'shop-light',
};

/** Icons from Lets Icons pack (Leonid Tsvetkov) — Figma Free Icon Pack 1800+ */
export function LetsIcon({ name, size = 20, className, bold = false, strokeWidth }: Props) {
  const resolvedName = OUTLINE_ALIASES[name] ?? name;
  const strokeClass = strokeWidth === 1.5 ? 'sa-icon-stroke-15' : strokeWidth === 2 ? 'sa-icon-stroke-2' : '';

  return (
    <Icon
      icon={`lets-icons:${resolvedName}`}
      width={size}
      height={size}
      className={[className, bold ? 'sa-icon-bold' : '', strokeClass].filter(Boolean).join(' ') || undefined}
      aria-hidden
    />
  );
}
