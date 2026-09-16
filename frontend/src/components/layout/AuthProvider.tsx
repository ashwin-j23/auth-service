import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useSilentRefresh } from '../../hooks/useSilentRefresh';
import { Spinner } from '../ui/Spinner';

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
    // Runs once on mount — bootstrap is a stable store action, not reactive state.
  }, [bootstrap]);

  useSilentRefresh();

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-[rgb(var(--color-bg))]">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25 }}
          className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white"
        >
          <ShieldCheck size={24} className="text-brand-500" />
          Auth Console
        </motion.div>
        <Spinner size="lg" className="text-brand-500" />
      </div>
    );
  }

  return <>{children}</>;
}
