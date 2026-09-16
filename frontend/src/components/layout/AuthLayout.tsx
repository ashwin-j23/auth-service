import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Lock, RotateCw, ShieldCheck } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

const highlights = [
  { icon: RotateCw, text: 'Bank-grade session security with rotating refresh tokens' },
  { icon: ShieldCheck, text: 'Google Sign-In backed by PKCE and nonce verification' },
  { icon: Lock, text: 'Every session revocable in one click, from anywhere' },
];

// A faint SVG-noise data URI, mixed in at very low opacity over the gradient
// glow below — flat radial gradients banding on dark backgrounds is the
// single biggest tell of an unpolished hero panel, and grain is the cheapest
// fix.
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

function FloatingBadge({
  icon: Icon,
  label,
  className,
  delay = 0,
  duration = 6,
}: Readonly<{
  icon: typeof ShieldCheck;
  label: string;
  className: string;
  delay?: number;
  duration?: number;
}>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: [0, -14, 0] }}
      transition={{
        opacity: { duration: 0.5, delay: 0.4 },
        y: { duration, repeat: Infinity, ease: 'easeInOut', delay },
      }}
      className={`absolute flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3.5 py-2 text-xs font-medium text-white shadow-elevated-dark backdrop-blur-md ${className}`}
    >
      <Icon size={14} className="text-brand-200" />
      {label}
    </motion.div>
  );
}

export function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-[rgb(var(--color-bg))]">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-slate-950 p-12 text-white lg:flex">
        {/* Aurora glow blobs */}
        <div
          className="pointer-events-none absolute -top-32 -right-24 h-[28rem] w-[28rem] rounded-full bg-brand-500/40 blur-3xl animate-pulse-glow"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-40 -left-16 h-[24rem] w-[24rem] rounded-full bg-accent-500/30 blur-3xl animate-pulse-glow"
          style={{ animationDelay: '2s' }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.05] mix-blend-overlay"
          style={{ backgroundImage: `url("${GRAIN}")` }}
          aria-hidden="true"
        />

        <FloatingBadge icon={KeyRound} label="Rotating refresh tokens" className="right-10 top-24" delay={0} duration={7} />
        <FloatingBadge icon={ShieldCheck} label="PKCE + nonce verified" className="left-10 top-44" delay={1.2} duration={8} />

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="relative flex items-center gap-2 text-lg font-semibold"
        >
          <ShieldCheck size={26} className="text-brand-300" />
          Auth Console
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
          className="relative space-y-7"
        >
          <h1 className="max-w-sm text-4xl font-extrabold leading-[1.1] tracking-tight">
            Secure access,
            <br />
            <span className="bg-gradient-to-r from-brand-200 via-white to-accent-200 bg-clip-text text-transparent">
              built for production.
            </span>
          </h1>
          <ul className="space-y-3.5 text-sm text-slate-300">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/10">
                  <Icon size={12} className="text-brand-200" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </motion.div>

        <p className="relative text-xs text-slate-500">
          &copy; {new Date().getFullYear()} Auth Console. All rights reserved.
        </p>
      </div>

      <div className="flex w-full flex-col lg:w-1/2">
        <div className="flex items-center justify-between px-6 py-5 lg:justify-end">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white lg:hidden">
            <ShieldCheck size={22} className="text-brand-500" />
            Auth Console
          </div>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="w-full max-w-sm"
          >
            {children}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
