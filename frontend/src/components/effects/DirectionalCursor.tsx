import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface DirectionalCursorProps {
  /** Region the effect is active in — cursor tracking is scoped here, not the whole page. */
  containerRef: RefObject<HTMLElement>;
  /** Element the arrow always points at. */
  targetRef: RefObject<HTMLElement>;
  /**
   * The arrow artwork isn't drawn pointing at 0deg in its own viewBox, so every
   * computed bearing needs this correction to actually aim at the target.
   */
  angleOffsetDeg?: number;
  /**
   * Skips the `prefers-reduced-motion` check. Only for a page whose entire
   * content IS this effect (an explicit showcase/demo) — everywhere else,
   * decorative motion must keep respecting the user's preference.
   */
  ignoreReducedMotion?: boolean;
}

/**
 * Decorative-only: a custom arrow that tracks the pointer and rotates to aim
 * at `targetRef`, replacing the system cursor while inside `containerRef`.
 * Never attaches on touch/coarse pointers — there is no functional fallback
 * because the effect carries no information beyond "look over there."
 */
export function DirectionalCursor({
  containerRef,
  targetRef,
  angleOffsetDeg = 20,
  ignoreReducedMotion = false,
}: DirectionalCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    const target = targetRef.current;
    const cursor = cursorRef.current;
    const icon = iconRef.current;
    if (!container || !target || !cursor || !icon) return;

    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduceMotion = !ignoreReducedMotion && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!canHover || reduceMotion) return;

    let overTarget = false;

    function setVisible(next: boolean) {
      if (visibleRef.current === next) return;
      visibleRef.current = next;
      cursor!.classList.toggle('is-visible', next);
    }

    function applyFrame() {
      rafRef.current = null;
      const rect = target!.getBoundingClientRect();
      const targetCenterX = rect.left + rect.width / 2;
      const targetCenterY = rect.top + rect.height / 2;
      const { x, y } = pointRef.current;
      const bearing =
        Math.atan2(targetCenterX - x, targetCenterY - y) * (180 / Math.PI) * -1 + 180 + angleOffsetDeg;

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
      setVisible(!overTarget);
      scheduleFrame();
    }

    function handleContainerLeave() {
      setVisible(false);
    }

    function handleTargetEnter() {
      overTarget = true;
      setVisible(false);
    }

    function handleTargetLeave() {
      overTarget = false;
    }

    container.style.cursor = 'none';
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerleave', handleContainerLeave);
    target.addEventListener('pointerenter', handleTargetEnter);
    target.addEventListener('pointerleave', handleTargetLeave);

    return () => {
      container.style.cursor = '';
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerleave', handleContainerLeave);
      target.removeEventListener('pointerenter', handleTargetEnter);
      target.removeEventListener('pointerleave', handleTargetLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, targetRef, angleOffsetDeg, ignoreReducedMotion]);

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
