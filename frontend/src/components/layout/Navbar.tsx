import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Settings, ShieldCheck, User } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { api } from '../../lib/api/client';
import { Avatar } from '../ui/Avatar';
import { Dropdown } from '../ui/Dropdown';
import { ThemeToggle } from './ThemeToggle';
import { toast } from 'sonner';

export function Navbar() {
  const { user, refreshToken, clear } = useAuthStore();
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      if (refreshToken) await api.logout(refreshToken);
    } catch {
      // Best-effort — the local session is cleared regardless below, so a
      // network hiccup here shouldn't strand the user in a "logged in" UI
      // with no way out.
    } finally {
      clear();
      toast.success('Signed out');
      navigate('/login');
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-[rgb(var(--color-bg))]/80">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <ShieldCheck size={22} className="text-brand-500" />
          Auth Console
        </Link>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          {user && (
            <Dropdown
              trigger={<Avatar name={user.name} email={user.email} size="sm" />}
              items={[
                { label: 'Profile settings', icon: <User size={15} />, onSelect: () => navigate('/settings/profile') },
                { label: 'Security', icon: <Settings size={15} />, onSelect: () => navigate('/settings/security') },
                { label: 'Sign out', icon: <LogOut size={15} />, danger: true, onSelect: handleLogout },
              ]}
            />
          )}
        </div>
      </div>
    </header>
  );
}
