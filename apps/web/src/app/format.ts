import { useTranslation } from 'react-i18next';
import type { Msg } from '@packet-trip/engine';
import { useCallback } from 'react';

export function useFormat() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const ms = useCallback(
    (us: number | null | undefined, digits = 1): string => {
      if (us === null || us === undefined) return '—';
      return `${new Intl.NumberFormat(lng, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(us / 1000)} ms`;
    },
    [lng],
  );
  const num = useCallback((n: number): string => new Intl.NumberFormat(lng).format(n), [lng]);
  const bytes = useCallback(
    (n: number): string =>
      n >= 10_000
        ? `${new Intl.NumberFormat(lng, { maximumFractionDigits: 1 }).format(n / 1024)} KB`
        : `${new Intl.NumberFormat(lng).format(n)} B`,
    [lng],
  );
  /** Swaps "@node:laptop" references from the engine for translated node names. */
  const ref = useCallback(
    (s: string): string => s.replace(/@node:(\w+)/g, (_m, id: string) => t(`node.${id}`)),
    [t],
  );
  const msg = useCallback(
    (m: Msg | null | undefined): string => {
      if (!m) return '';
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(m.params ?? {}))
        params[k] = typeof v === 'string' ? ref(v) : v;
      return t(m.key, { ...params, defaultValue: m.key });
    },
    [t, ref],
  );
  return { t, ms, num, bytes, msg, ref, lng };
}
