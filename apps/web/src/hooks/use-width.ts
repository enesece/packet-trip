import { useLayoutEffect, useRef, useState } from 'react';

/** Tracks an element's content width so SVGs can draw at real pixel size. */
export function useWidth<T extends HTMLElement>(
  fallback: number,
): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.max(200, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(200, Math.round(el.clientWidth || fallback)));
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
}
