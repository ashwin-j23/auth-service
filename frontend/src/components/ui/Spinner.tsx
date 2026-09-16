import { cn } from '../../lib/utils/cn';

const sizes = {
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[3px]',
};

export function Spinner({
  size = 'md',
  className,
  label = 'Loading',
}: Readonly<{
  size?: keyof typeof sizes;
  className?: string;
  label?: string;
}>) {
  return (
    <output
      aria-label={label}
      className={cn(
        'inline-block animate-spin rounded-full border-current border-t-transparent text-current',
        sizes[size],
        className,
      )}
    />
  );
}
