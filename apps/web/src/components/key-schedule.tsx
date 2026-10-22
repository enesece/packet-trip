import { useSim } from '../state/use-sim';
import { useFormat } from '../app/format';

/** Walks through every secret derived by the real TLS 1.3 key schedule (phase 2). */
export function KeySchedulePanel() {
  const { t, msg } = useFormat();
  const steps = useSim((v) => v.keySchedule);
  const reason = useSim((v) => v.fallbackReason);
  if (!steps) {
    return (
      <div className="text-[14px] text-muted">
        <p>{t('keys.unavailable')}</p>
        {reason && (
          <p className="mt-2">{t(`crypto.fallback.${reason}`, { defaultValue: reason })}</p>
        )}
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={s.id} className="card p-3">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[12px] text-muted">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-[14px] font-semibold">
              {t(`keyname.${s.id}`, { defaultValue: s.name })}
            </span>
          </div>
          <p className="mono mt-1 text-[12px] text-muted">{s.formula}</p>
          <p className="mono mt-1 break-all text-[12px]" style={{ color: 'var(--layer-security)' }}>
            {s.value}
          </p>
          <p className="mt-1.5 text-[13px]">{msg(s.explain)}</p>
        </li>
      ))}
    </ol>
  );
}
