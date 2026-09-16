type FlowButtonProps = {
  text?: string;
  href?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  className?: string;
  disabled?: boolean;
  /** default: outline → fill; solid: black primary; bright: white primary; white: outline on dark */
  variant?: 'default' | 'white' | 'solid' | 'bright';
};

const VARIANT_CLASS = {
  default: 'sl-flow-btn--default',
  white: 'sl-flow-btn--white',
  solid: 'sl-flow-btn--solid',
  bright: 'sl-flow-btn--bright',
} as const;

export function FlowButton({
  text = 'Modern Button',
  href,
  onClick,
  type = 'button',
  className = '',
  disabled = false,
  variant = 'default',
}: FlowButtonProps) {
  const classes = ['sl-flow-btn', VARIANT_CLASS[variant], className].filter(Boolean).join(' ');

  if (href && !disabled) {
    return (
      <a href={href} className={classes}>
        {text}
      </a>
    );
  }

  return (
    <button type={type} onClick={onClick} className={classes} disabled={disabled}>
      {text}
    </button>
  );
}
