import { motion } from 'framer-motion';
import { cn } from '../../lib/utils/cn';

function scorePassword(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(score, 4);
}

const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
const colors = ['bg-slate-300 dark:bg-slate-700', 'bg-danger-500', 'bg-warning-500', 'bg-brand-500', 'bg-success-500'];

export function PasswordStrengthMeter({ password }: Readonly<{ password: string }>) {
  const score = scorePassword(password);
  if (!password) return null;

  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: i < score ? '100%' : '0%' }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className={cn('h-full rounded-full', colors[score])}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{labels[score]}</p>
    </div>
  );
}
