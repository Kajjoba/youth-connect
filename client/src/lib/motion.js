import { useEffect, useRef, useState } from 'react';

/**
 * =====================================================================
 * MOTION
 *
 * A handful of small, dependency-free hooks that make the interface feel
 * alive: numbers count up instead of appearing, rows settle into place
 * as they arrive rather than snapping in, and a certificate gets a
 * moment of celebration instead of just showing up.
 *
 * DELIBERATELY NOT A LIBRARY. This platform's whole argument is that it
 * costs little to load and run on a cheap phone (see ADR-008, ADR-009 in
 * styles.css). Pulling in an animation library to make a number count up
 * would spend the bandwidth budget on the wrong thing. Everything here
 * is requestAnimationFrame, IntersectionObserver and CSS transitions,
 * all of which the browser already ships.
 *
 * Every hook here respects prefers-reduced-motion by finishing instantly
 * rather than skipping the effect: a participant who has asked for less
 * motion still sees the final number and the final layout, just without
 * the animation getting there.
 * =====================================================================
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * useCountUp: animates a number from its previous value to a new one.
 *
 * Used anywhere a figure updates. A static number that changes between
 * renders is easy to miss; one that visibly moves toward its new value
 * tells the person something happened without them having to notice a
 * digit changed.
 */
export function useCountUp(target, { duration = 700 } = {}) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(target) ? target : 0;

    if (from === to) return undefined;

    if (prefersReducedMotion()) {
      setDisplay(to);
      fromRef.current = to;
      return undefined;
    }

    const start = performance.now();
    const easeOutQuad = (t) => t * (2 - t);

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / duration);
      const eased = easeOutQuad(progress);
      setDisplay(Math.round(from + (to - from) * eased));

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return display;
}

/**
 * useReveal: a ref to attach to an element, plus whether it has entered
 * the viewport. Pairs with the `.reveal` / `.reveal-in` CSS classes.
 *
 * IntersectionObserver rather than a scroll listener: the browser does
 * the work off the main thread, and there is nothing to throttle or
 * clean up beyond disconnecting the one observer.
 *
 * `once` (the default) stops observing after the first reveal, because
 * a row that fades in every time it scrolls back into view reads as
 * flickering, not as life.
 */
export function useReveal({ once = true, threshold = 0.15 } = {}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (prefersReducedMotion() || visible) return undefined;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) observer.disconnect();
          }
        }
      },
      { threshold }
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, visible];
}

/**
 * confettiBurst: a short-lived scatter of small rectangles from a point
 * on screen, for the one moment in this application that has earned a
 * celebration: a certificate landing.
 *
 * Plain DOM nodes animated with the Web Animations API, not canvas and
 * not a particle library. Twenty-four elements that exist for under a
 * second cost nothing worth measuring, and the browser garbage-collects
 * them the moment their animation finishes because nothing keeps a
 * reference.
 *
 * A no-op under prefers-reduced-motion, which is the correct behaviour
 * for an effect that exists purely to delight rather than to inform.
 */
export function confettiBurst(originEl) {
  if (prefersReducedMotion() || typeof document === 'undefined') return;
  if (!originEl || typeof originEl.getBoundingClientRect !== 'function') return;

  const rect = originEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height * 0.3;

  const colors = ['#E8B33A', '#17594A', '#FFD166', '#2C8C6F', '#FFFFFF'];
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(host);

  const pieces = 26;
  for (let i = 0; i < pieces; i += 1) {
    const piece = document.createElement('span');
    const size = 5 + Math.random() * 5;
    const color = colors[i % colors.length];
    piece.style.cssText = `
      position:absolute; left:${originX}px; top:${originY}px;
      width:${size}px; height:${size * 0.4}px; background:${color};
      border-radius:1px; opacity:0.95;
    `;
    host.appendChild(piece);

    const angle = (Math.PI * 2 * i) / pieces + (Math.random() - 0.5) * 0.6;
    const distance = 90 + Math.random() * 140;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 60; // biased upward, then falls
    const spin = (Math.random() - 0.5) * 720;

    piece.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy + 220}px) rotate(${spin}deg)`, opacity: 0 }
      ],
      { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.6,.3,1)' }
    );
  }

  setTimeout(() => host.remove(), 1700);
}

/**
 * A tiny press-ripple for buttons, wired once from a single delegated
 * listener (see App.jsx) rather than a handler on every button. One
 * listener on the document costs nothing whether the page has three
 * buttons or three hundred.
 */
export function attachRipple() {
  if (typeof document === 'undefined') return () => {};

  function onPointerDown(event) {
    if (prefersReducedMotion()) return;
    const target = event.target.closest?.('.btn, .chip, .tab, .nav-link, .segment');
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height) * 1.6;
    const x = (event.clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (event.clientY ?? rect.top + rect.height / 2) - rect.top;

    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x - size / 2}px`;
    ripple.style.top = `${y - size / 2}px`;

    const previousPosition = getComputedStyle(target).position;
    if (previousPosition === 'static') target.style.position = 'relative';
    target.style.overflow = target.style.overflow || 'hidden';
    target.appendChild(ripple);

    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  }

  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  return () => document.removeEventListener('pointerdown', onPointerDown);
}
