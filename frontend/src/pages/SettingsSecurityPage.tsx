import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { KeyRound, LogOut, MonitorSmartphone, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { useAuthStore } from '../store/authStore';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Alert } from '../components/ui/Alert';
import { Modal } from '../components/ui/Modal';
import { useCountdown } from '../hooks/useCountdown';

export default function SettingsSecurityPage() {
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  const [sendingReset, setSendingReset] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const cooldown = useCountdown(cooldownSeconds);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  if (!user) return null;

  async function handleSendReset() {
    setSendingReset(true);
    try {
      await api.requestPasswordReset(user!.email);
      setResetSent(true);
      setCooldownSeconds(60);
      toast.success('Password reset email sent');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setCooldownSeconds(err.retryAfterSeconds ?? 900);
        toast.error('Too many attempts. Please wait before trying again.');
      } else {
        toast.error('Could not send reset email. Please try again.');
      }
    } finally {
      setSendingReset(false);
    }
  }

  async function handleSignOut() {
    try {
      if (refreshToken) await api.logout(refreshToken);
    } finally {
      clear();
      toast.success('Signed out of this device');
      navigate('/login');
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Security</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Manage your password and active sessions.</p>
      </div>

      <Card className="space-y-4">
        <div className="flex items-center gap-2 text-slate-900 dark:text-white">
          <KeyRound size={18} className="text-brand-500" />
          <h2 className="font-semibold">Password</h2>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          This API doesn&apos;t expose an in-session &quot;change password&quot; endpoint — resetting sends a
          secure link to your email instead, the same flow as &quot;forgot password&quot;. Using it revokes every
          other active session.
        </p>
        {resetSent && (
          <Alert variant="success">Check {user.email} for a link to set a new password.</Alert>
        )}
        <Button variant="secondary" onClick={handleSendReset} loading={sendingReset} disabled={cooldown > 0}>
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send password reset email'}
        </Button>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-2 text-slate-900 dark:text-white">
          <MonitorSmartphone size={18} className="text-brand-500" />
          <h2 className="font-semibold">Active sessions</h2>
        </div>
        <div className="flex items-center justify-between rounded-input border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/40">
          <div>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">This device</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">Signed in via {navigator.userAgent.includes('Chrome') ? 'Chrome' : 'this browser'}</p>
          </div>
          <Badge variant="success">Current</Badge>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-slate-400 dark:text-slate-500">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          Listing and revoking sessions on other devices needs a backend endpoint this API doesn&apos;t currently
          expose. Resetting your password (above) revokes all sessions everywhere as a workaround.
        </p>
        <Button variant="danger" size="sm" onClick={() => setConfirmSignOut(true)}>
          <LogOut size={14} />
          Sign out of this device
        </Button>
      </Card>

      <Modal
        open={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        title="Sign out of this device?"
        description="You'll need to sign in again to access your account."
        variant="confirmation"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmSignOut(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleSignOut}>
              Sign out
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-500 dark:text-slate-400">This action ends your current session immediately.</p>
      </Modal>
    </motion.div>
  );
}
