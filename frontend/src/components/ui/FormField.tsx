import { cloneElement, isValidElement, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils/cn';

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
  className?: string;
}

export function FormField({
  label,
  htmlFor,
  error,
  helperText,
  required,
  children,
  className,
}: Readonly<FormFieldProps>) {
  const generatedId = useId();
  const fieldId = htmlFor ?? generatedId;
  const errorId = `${fieldId}-error`;
  const helperId = `${fieldId}-helper`;

  const describedBy = [error && errorId, helperText && !error && helperId].filter(Boolean).join(' ') || undefined;

  const child = isValidElement(children)
    ? cloneElement(children, {
        id: fieldId,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy,
      })
    : children;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
        {required && <span className="ml-0.5 text-danger-500">*</span>}
      </label>
      {child}
      {renderFieldNote({ error, errorId, helperText, helperId })}
    </div>
  );
}

function renderFieldNote({
  error,
  errorId,
  helperText,
  helperId,
}: Readonly<{ error?: string; errorId: string; helperText?: string; helperId: string }>) {
  if (error) {
    return (
      <p id={errorId} role="alert" className="flex items-center gap-1 text-xs font-medium text-danger-500 animate-fade-in">
        <AlertCircle size={13} className="shrink-0" />
        {error}
      </p>
    );
  }
  if (helperText) {
    return (
      <p id={helperId} className="text-xs text-slate-500 dark:text-slate-400">
        {helperText}
      </p>
    );
  }
  return null;
}

export function FieldError({ children }: Readonly<{ children?: ReactNode }>) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-center gap-1 text-xs font-medium text-danger-500 animate-fade-in">
      <AlertCircle size={13} className="shrink-0" />
      {children}
    </p>
  );
}
