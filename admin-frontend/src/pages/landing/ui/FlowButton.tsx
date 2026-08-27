import { ArrowRight } from 'lucide-react';

type FlowButtonProps = {
  text?: string;
  href?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  className?: string;
  /** White outline on dark surfaces; fills white on hover */
  variant?: 'default' | 'white';
};

const BASE =
  'group relative inline-flex items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] bg-transparent px-8 py-3 text-sm font-semibold no-underline cursor-pointer transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-transparent hover:rounded-[12px] active:scale-[0.95]';

const VARIANT = {
  default: 'border-[#333333]/40 text-[#111111] hover:text-white',
  white: 'border-white/90 text-white hover:text-[#111111]',
} as const;

const ARROW = {
  default:
    'stroke-[#111111] group-hover:stroke-white',
  white:
    'stroke-white group-hover:stroke-[#111111]',
} as const;

const FILL = {
  default: 'bg-[#111111]',
  white: 'bg-white',
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
  const arrowTone = ARROW[variant];
  const fillTone = FILL[variant];

  const content = (
    <>
      <ArrowRight
        className={`absolute w-4 h-4 left-[-25%] fill-none z-[9] group-hover:left-4 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] ${arrowTone}`}
        aria-hidden
      />
      <span className="relative z-[1] -translate-x-3 group-hover:translate-x-3 transition-all duration-[800ms] ease-out">
        {text}
      </span>
      {/* Scale (not fixed px) so fill covers long labels */}
      <span
        className={`pointer-events-none absolute top-1/2 left-1/2 z-0 size-4 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full opacity-0 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:scale-[80] group-hover:opacity-100 ${fillTone}`}
        aria-hidden
      />
      <ArrowRight
        className={`absolute w-4 h-4 right-4 fill-none z-[9] group-hover:right-[-25%] transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] ${arrowTone}`}
        aria-hidden
      />
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
