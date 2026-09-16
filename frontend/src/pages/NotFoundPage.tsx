import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Compass } from 'lucide-react';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';

export default function NotFoundPage() {
  return (
    <AuthLayout>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center gap-4 py-6 text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-900/30">
          <Compass size={28} className="text-brand-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Page not found</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">The page you&apos;re looking for doesn&apos;t exist.</p>
        <Link to="/dashboard">
          <Button className="mt-2" data-cursor-target>Go to dashboard</Button>
        </Link>
      </motion.div>
    </AuthLayout>
  );
}
