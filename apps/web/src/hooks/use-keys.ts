import { useEffect, useRef } from 'react';

/** Screen-scoped keyboard shortcuts; ignored while typing or inside widgets that use arrows. */
export function useKeys(map: Readonly<Record<string, () => void>>): void {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable)
        return;
      // Widgets that use these keys themselves keep them.
      if (
        el?.closest(
          '[role="slider"], [role="listbox"], [role="dialog"], [role="toolbar"], [role="radiogroup"], [role="tree"]',
        )
      )
        return;
      if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return;
      const fn = ref.current[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
