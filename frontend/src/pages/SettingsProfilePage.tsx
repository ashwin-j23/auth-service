import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BadgeCheck, Calendar, Info, Mail, User } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { Alert } from '../components/ui/Alert';

function ReadOnlyField({ icon: Icon, label, value }: Readonly<{ icon: typeof User; label: string; value: string }>) {
  return (
    <div className="flex items-center gap-3 rounded-input border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/40">
      <Icon size={16} className="shrink-0 text-slate-400" />
      <div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{value}</p>
      </div>
    </div>
  );
}

export default function SettingsProfilePage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  const memberSince = new Date(user.createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Profile</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Your account details.</p>
      </div>

      <Card className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar name={user.name} email={user.email} size="xl" />
          <div>
            <p className="text-lg font-semibold text-slate-900 dark:text-white">{user.name || 'No name set'}</p>
            <Badge variant={user.isEmailVerified ? 'success' : 'warning'} className="mt-1">
              <BadgeCheck size={12} />
              {user.isEmailVerified ? 'Verified' : 'Unverified'}
            </Badge>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ReadOnlyField icon={User} label="Name" value={user.name || '—'} />
          <ReadOnlyField icon={Mail} label="Email" value={user.email} />
          <ReadOnlyField icon={Calendar} label="Member since" value={memberSince} />
          <ReadOnlyField icon={BadgeCheck} label="Email status" value={user.isEmailVerified ? 'Verified' : 'Unverified'} />
        </div>

        <Alert variant="info" title="Editing isn't available yet">
          <span>
            This API doesn&apos;t currently expose an endpoint to update your name or email — only signup, login,
            and the OAuth/verification/reset flows. Once a profile-update endpoint ships, this form becomes
            editable.
          </span>
        </Alert>

        {!user.isEmailVerified && (
          <div className="flex items-center gap-2 text-sm">
            <Info size={15} className="shrink-0 text-brand-500" />
            <Link to="/verify-email?pending=true" className="font-medium text-brand-500 hover:underline">
              Verify your email address
            </Link>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
