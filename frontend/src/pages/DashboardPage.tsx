import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Calendar, KeyRound, Laptop, Mail, RefreshCw, Settings, ShieldCheck, UserCog } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useMe } from '../hooks/useMe';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const { isFetching, refetch } = useMe();

  if (!user) return null;

  const memberSince = new Date(user.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      <motion.div variants={item} className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Welcome back{user.name ? `, ${user.name}` : ''}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Here&apos;s what&apos;s happening with your account.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => refetch()} loading={isFetching}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </motion.div>

      {!user.isEmailVerified && (
        <motion.div variants={item}>
          <Alert variant="warning" title="Verify your email">
            Some features are limited until you confirm your email address.{' '}
            <Link to="/verify-email?pending=true" className="font-medium underline">
              Verify now
            </Link>
          </Alert>
        </motion.div>
      )}

      <motion.div variants={item}>
        <Card className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Avatar name={user.name} email={user.email} size="lg" />
            <div>
              <p className="text-lg font-semibold text-slate-900 dark:text-white">{user.name || 'No name set'}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">{user.email}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge variant={user.isEmailVerified ? 'success' : 'warning'}>
                  {user.isEmailVerified ? 'Email verified' : 'Email unverified'}
                </Badge>
                <Badge variant="info">Active account</Badge>
              </div>
            </div>
          </div>
          <Link to="/settings/profile">
            <Button variant="secondary" size="sm">
              <UserCog size={15} />
              Edit profile
            </Button>
          </Link>
        </Card>
      </motion.div>

      <div className="grid gap-6 md:grid-cols-2">
        <motion.div variants={item}>
          <Card className="h-full space-y-4">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white">
              <Laptop size={18} className="text-brand-500" />
              <h2 className="font-semibold">Active session</h2>
            </div>
            <div className="flex items-center justify-between rounded-input border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/40">
              <div>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">This device</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Current browser session</p>
              </div>
              <Badge variant="success">Current</Badge>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Session listing across devices requires a backend endpoint not yet exposed by this API.
            </p>
          </Card>
        </motion.div>

        <motion.div variants={item}>
          <Card className="h-full space-y-4">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white">
              <ShieldCheck size={18} className="text-brand-500" />
              <h2 className="font-semibold">Security</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <KeyRound size={15} className="text-slate-400" />
                Password-based authentication
              </div>
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <Mail size={15} className="text-slate-400" />
                {user.isEmailVerified ? 'Recovery email confirmed' : 'Recovery email unconfirmed'}
              </div>
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <Calendar size={15} className="text-slate-400" />
                Member since {memberSince}
              </div>
            </div>
            <Link to="/settings/security">
              <Button variant="secondary" size="sm">
                <Settings size={14} />
                Manage security
              </Button>
            </Link>
          </Card>
        </motion.div>
      </div>
    </motion.div>
  );
}
