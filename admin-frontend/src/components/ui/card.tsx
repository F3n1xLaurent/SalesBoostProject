import React from 'react';
import { cn } from '../../lib/utils';
export function Card({ className, ...props }: React.ComponentProps<'section'>) { return <section className={cn('av-card', className)} {...props} />; }
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) { return <div className={cn('av-card-header', className)} {...props} />; }
export function CardTitle(props: React.ComponentProps<'h2'>) { return <h2 {...props} />; }
export function CardContent(props: React.ComponentProps<'div'>) { return <div {...props} />; }
