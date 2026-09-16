import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils/cn';

type Variant = 'info' | 'success' | 'warning' | 'danger';

const config: Record<Variant, { icon: typeof Info; classes: string; iconClasses: string }> = {
  info: {
    icon: Info,
    classes: 'bg-brand-50 text-brand-700 border-brand-100 dark:bg-brand-900/30 dark:text-brand-200 dark:border-brand-800',
    iconClasses: 'text-brand-500',
  },
  success: {
    icon: CheckCircle2,
    classes: 'bg-success-50 text-success-600 border-success-100 dark:bg-success-500/10 dark:text-success-500 dark:border-success-500/20',
    iconClasses: 'text-success-500',
  },
  warning: {
    icon: AlertTriangle,
    classes: 'bg-warning-50 text-warning-600 border-warning-100 dark:bg-warning-500/10 dark:text-warning-500 dark:border-warning-500/20',
    iconClasses: 'text-warning-500',
  },
  danger: {
    icon: XCircle,
    classes: 'bg-danger-50 text-danger-600 border-danger-100 dark:bg-danger-500/10 dark:text-danger-500 dark:border-danger-500/20',
    iconClasses: 'text-danger-500',
  },
};

export function Alert({
  variant = 'info',
  title,
  children,
  onDismiss,
  className,
}: Readonly<{
  variant?: Variant;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}>) {
  const { icon: Icon, classes, iconClasses } = config[variant];
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-card border px-4 py-3 text-sm animate-fade-in-up',
        classes,
        className,
      )}
    >
      <Icon size={18} className={cn('mt-0.5 shrink-0', iconClasses)} />
      <div className="flex-1 space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="leading-relaxed opacity-90">{children}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
