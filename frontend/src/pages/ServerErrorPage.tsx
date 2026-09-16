import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { RefreshCw, ServerCrash } from 'lucide-react';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';

export default function ServerErrorPage() {
  const navigate = useNavigate();

  return (
    <AuthLayout>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center gap-4 py-6 text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
          <ServerCrash size={28} className="text-slate-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Something went wrong</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          We hit an unexpected error on our end. Please try again in a moment.
        </p>
        <Button className="mt-2" onClick={() => navigate(0)} data-cursor-target>
          <RefreshCw size={15} />
          Try again
        </Button>
        <Link to="/login" className="text-sm font-medium text-brand-500 hover:underline">
          Back to sign in
        </Link>
      </motion.div>
    </AuthLayout>
  );
}
