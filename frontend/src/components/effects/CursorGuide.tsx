import { useEffect, useRef } from 'react';

const TARGET_SELECTOR = '[data-cursor-target]';
const SUPPRESS_SELECTOR = 'input, textarea, select, [contenteditable="true"], [data-cursor-target]';
const OFFSET_PX = 20;
const ANGLE_OFFSET_DEG = 20;

/**
 * Site-wide cursor guide: a small arrow that rides near the real pointer
 * (never replacing it — this app has real text inputs, so the system cursor
 * always stays visible) and rotates to aim at whichever element on the
 * current page carries `data-cursor-target`. Mount once at the app root;
 * it re-queries the target on every move, so it follows route changes
 * automatically without needing to know about individual pages.
 *
 * Hidden over the target itself and over form controls, where a directional
 * hint would just be visual noise while someone's reading or typing.
 */
export function CursorGuide() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(false);

  useEffect(() => {
    const cursor = cursorRef.current;
    const icon = iconRef.current;
    if (!cursor || !icon) return;

    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!canHover || reduceMotion) return;

    cursor.style.setProperty('--ox', `${OFFSET_PX}px`);
    cursor.style.setProperty('--oy', `${OFFSET_PX}px`);

    function setVisible(next: boolean) {
      if (visibleRef.current === next) return;
      visibleRef.current = next;
      cursor!.classList.toggle('is-visible', next);
    }

    function applyFrame() {
      rafRef.current = null;
      const target = document.querySelector<HTMLElement>(TARGET_SELECTOR);
      if (!target) {
        setVisible(false);
        return;
      }
      const rect = target.getBoundingClientRect();
      const targetCenterX = rect.left + rect.width / 2;
      const targetCenterY = rect.top + rect.height / 2;
      const { x, y } = pointRef.current;
      const bearing =
        Math.atan2(targetCenterX - x, targetCenterY - y) * (180 / Math.PI) * -1 + 180 + ANGLE_OFFSET_DEG;

      cursor!.style.setProperty('--x', `${x}px`);
      cursor!.style.setProperty('--y', `${y}px`);
      icon!.style.setProperty('--r', `${bearing}deg`);
    }

    function scheduleFrame() {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(applyFrame);
      }
    }

    function handlePointerMove(e: PointerEvent) {
      pointRef.current = { x: e.clientX, y: e.clientY };
      const target = document.querySelector<HTMLElement>(TARGET_SELECTOR);
      const overSuppressed = e.target instanceof Element && e.target.closest(SUPPRESS_SELECTOR) !== null;
      setVisible(Boolean(target) && !overSuppressed);
      scheduleFrame();
    }

    function handleWindowLeave() {
      setVisible(false);
    }

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerleave', handleWindowLeave);

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handleWindowLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div ref={cursorRef} className="directional-cursor" aria-hidden="true">
      <div ref={iconRef} className="directional-cursor__icon">
        <svg viewBox="0 0 28 28" width="28" height="28">
          <polygon fill="#FFFFFF" points="8.2,20.9 8.2,4.9 19.8,16.5 13,16.5 12.6,16.6" />
          <polygon fill="#FFFFFF" points="17.3,21.6 13.7,23.1 9,12 12.7,10.5" />
          <rect
            x="12.5"
            y="13.6"
            transform="matrix(0.9221 -0.3871 0.3871 0.9221 -5.7605 6.5909)"
            width="2"
            height="8"
          />
          <polygon points="9.2,7.3 9.2,18.5 12.2,15.6 12.6,15.5 17.4,15.5" />
        </svg>
      </div>
    </div>
  );
}
