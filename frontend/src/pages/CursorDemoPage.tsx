import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { DirectionalCursor } from '../components/effects/DirectionalCursor';

export default function CursorDemoPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      ref={pageRef}
      className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden bg-slate-950 text-white"
    >
      <DirectionalCursor containerRef={pageRef} targetRef={ctaRef} ignoreReducedMotion />

      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/20 blur-3xl"
        aria-hidden="true"
      />

      <p className="relative text-sm text-slate-400">Cursor effect showcase — roam the page, then hover the button.</p>

      <button
        ref={ctaRef}
        type="button"
        className="relative rounded-full bg-white px-8 py-4 text-base font-semibold text-slate-900 shadow-elevated-dark transition-transform duration-150 ease-out hover:scale-[1.03]"
      >
        Call to action
      </button>

      <Link to="/login" className="relative mt-4 text-sm font-medium text-brand-300 hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
