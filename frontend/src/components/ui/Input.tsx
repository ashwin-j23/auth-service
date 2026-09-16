import { forwardRef, useId, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  success?: boolean;
}

const baseClasses =
  'block w-full rounded-input border bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 ' +
  'dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 transition-colors duration-150 ' +
  'focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60';

function stateClassesFor(error?: boolean, success?: boolean): string {
  if (error) return 'border-danger-500 focus:ring-danger-500/40';
  if (success) return 'border-success-500 focus:ring-success-500/40';
  return 'border-slate-300 dark:border-slate-700 focus:border-brand-500 focus:ring-brand-500/30';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, success, type, ...props }, ref) => {
    const isPassword = type === 'password';
    const [visible, setVisible] = useState(false);
    const generatedId = useId();
    const inputId = props.id ?? generatedId;

    const stateClasses = stateClassesFor(error, success);

    if (!isPassword) {
      return (
        <input
          ref={ref}
          id={inputId}
          type={type}
          className={cn(baseClasses, stateClasses, className)}
          {...props}
        />
      );
    }

    return (
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={cn(baseClasses, stateClasses, 'pr-10', className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    );
  },
);
Input.displayName = 'Input';
