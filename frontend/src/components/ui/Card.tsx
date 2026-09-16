import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

type Variant = 'elevated' | 'outlined' | 'filled';

const variants: Record<Variant, string> = {
  elevated: 'bg-white dark:bg-slate-900 shadow-elevated dark:shadow-elevated-dark border border-slate-100 dark:border-slate-800',
  outlined: 'bg-transparent border border-slate-200 dark:border-slate-800',
  filled: 'bg-slate-50 dark:bg-slate-800/60 border border-transparent',
};

export function Card({
  className,
  variant = 'elevated',
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: Variant }) {
  return <div className={cn('rounded-card p-6', variants[variant], className)} {...props} />;
}
