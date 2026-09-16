import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Navbar } from './Navbar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[rgb(var(--color-bg))]">
      <Navbar />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="mx-auto max-w-5xl px-6 py-10"
      >
        {children}
      </motion.main>
    </div>
  );
}
