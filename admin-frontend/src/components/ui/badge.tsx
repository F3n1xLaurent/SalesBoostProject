import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const variants = cva('av-badge', { variants: { variant: { default: 'av-badge-active', secondary: 'av-badge-fading', outline: 'av-badge-outline' } }, defaultVariants: { variant: 'default' } });
export function Badge({ variant, className, ...props }: React.ComponentProps<'span'> & VariantProps<typeof variants>) { return <span className={cn(variants({ variant }), className)} {...props} />; }
