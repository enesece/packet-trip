import { useState } from 'react';
import { siteFromUrl, SITE_IDS, type SiteId } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { useUi } from '../state/ui-store';
import { loadRun } from '../app/controller';
import { IconLock, IconReturn } from './ui/icons';

/** The big address bar: only the built-in sites are allowed. */
export function AddressBar() {
  const { t } = useFormat();
  const config = useUi((s) => s.config);
  const [value, setValue] = useState(`https://${config.site}`);
  const [unknown, setUnknown] = useState(false);

  const go = (site: SiteId): void => {
    setUnknown(false);
    setValue(`https://${site}`);
    useUi.getState().set({ started: true, selectedPacket: null });
    void loadRun({ config: { ...useUi.getState().config, site }, play: true });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const site = siteFromUrl(value);
    if (!site) {
      setUnknown(true);
      return;
    }
    go(site);
  };

  return (
    <div>
      <form
        onSubmit={submit}
        className="flex flex-col gap-3 sm:flex-row"
        role="search"
        aria-label={t('address.form')}
      >
        <label htmlFor="pt-address" className="sr-only">
          {t('address.label')}
        </label>
        <div className="flex h-14 min-w-0 flex-1 items-center gap-3 rounded-[14px] border border-line-strong bg-surface px-4 focus-within:outline focus-within:outline-2 focus-within:outline-[var(--focus)]">
          <span style={{ color: 'var(--text-network, var(--layer-network))' }}>
            <IconLock size={20} />
          </span>
          <input
            id="pt-address"
            className="mono min-w-0 flex-1 bg-transparent text-[18px] outline-none sm:text-[20px]"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setUnknown(false);
            }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            aria-invalid={unknown}
            aria-describedby={unknown ? 'pt-address-error' : undefined}
          />
        </div>
        <button type="submit" className="btn btn-primary h-14 rounded-[14px] px-6 text-[16px]">
          {t('address.enter')} <IconReturn size={18} />
        </button>
      </form>
      {unknown && (
        <div id="pt-address-error" role="alert" className="card mt-3 p-4">
          <p className="text-[14px] font-semibold">{t('address.unknown')}</p>
          <p className="mt-1 text-[13px] text-muted">{t('address.pick')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SITE_IDS.map((s) => (
              <button key={s} type="button" className="btn mono text-[13px]" onClick={() => go(s)}>
                {s}
                <span className="font-sans text-[12px] font-normal text-muted">
                  · {t(`site.${s}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
