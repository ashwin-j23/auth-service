import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShieldOff } from 'lucide-react';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';

export default function ForbiddenPage() {
  return (
    <AuthLayout>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center gap-4 py-6 text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-50 dark:bg-danger-500/10">
          <ShieldOff size={28} className="text-danger-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">This account has been disabled</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Your account access has been restricted. If you believe this is a mistake, reach out to support and
          we&apos;ll help sort it out.
        </p>
        <a href="mailto:support@yourdomain.com">
          <Button variant="secondary" className="mt-2">
            Contact support
          </Button>
        </a>
        <Link to="/login" className="text-sm font-medium text-brand-500 hover:underline">
          Back to sign in
        </Link>
      </motion.div>
    </AuthLayout>
  );
}
