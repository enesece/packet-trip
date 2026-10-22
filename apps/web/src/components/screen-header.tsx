import { useFormat } from '../app/format';
import { useUi } from '../state/ui-store';

/** Breadcrumb row shared by the stop screens: "Stop 1 · DNS lookup", current t, actions. */
export function ScreenHeader({ crumb, children }: { crumb: string; children?: React.ReactNode }) {
  const { t, ms } = useFormat();
  const now = useUi((s) => s.playheadUs);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4">
      <p className="eyebrow">{crumb}</p>
      <p
        className="mono rounded-md bg-surface-2 px-2 py-0.5 text-[12px] tabular-nums"
        aria-live="off"
      >
        {t('screen.t')} = {ms(now)}
      </p>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
