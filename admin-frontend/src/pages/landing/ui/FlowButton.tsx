type FlowButtonProps = {
  text?: string;
  href?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  className?: string;
  /** default: outline → fill; solid: black primary; bright: white primary; white: outline on dark */
  variant?: 'default' | 'white' | 'solid' | 'bright';
};

const BASE =
  'group relative inline-flex items-center justify-center overflow-hidden rounded-[100px] border-[1.5px] px-8 py-3 text-sm font-semibold no-underline cursor-pointer transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:rounded-[12px] active:scale-[0.95]';

const VARIANT = {
  default: 'bg-transparent border-[#333333]/40 text-[#111111] hover:text-white hover:border-transparent',
  white: 'bg-transparent border-white/90 text-white hover:text-[#111111] hover:border-transparent',
  solid: 'border-[#111111] !bg-[#111111] text-white',
  bright: 'border-white !bg-white text-[#111111]',
} as const;

const FILL = {
  default: 'bg-[#111111]',
  white: 'bg-white',
  solid: '',
  bright: '',
} as const;

export function FlowButton({
  text = 'Modern Button',
  href,
  onClick,
  type = 'button',
  className = '',
  variant = 'default',
}: FlowButtonProps) {
  const classes = `${BASE} ${VARIANT[variant]}${className ? ` ${className}` : ''}`;
  const fillTone = FILL[variant];

  const content = (
    <>
      <span className="relative z-[1]">{text}</span>
      {fillTone ? (
        <span
          className={`pointer-events-none absolute top-1/2 left-1/2 z-0 size-4 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full opacity-0 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:scale-[80] group-hover:opacity-100 ${fillTone}`}
          aria-hidden
        />
      ) : null}
    </>
  );

  if (href) {
    return (
      <a href={href} className={classes}>
        {content}
      </a>
    );
  }

  return (
    <button type={type} onClick={onClick} className={classes}>
      {content}
    </button>
  );
}
