import { useTranslation } from 'react-i18next';
import { LAYERS_TOP_DOWN, layerVar } from '../design/layer-colors';

export function Legend() {
  const { t } = useTranslation();
  return (
    <section className="card p-5" id="layers" aria-labelledby="legend-title">
      <h2 id="legend-title" className="text-[16px] font-semibold">
        {t('legend.title')}
      </h2>
      <p className="mt-1 text-[13px] text-muted">{t('legend.sub')}</p>
      <ul className="mt-4 space-y-2.5">
        {LAYERS_TOP_DOWN.map((l) => (
          <li key={l} className="flex items-center gap-3">
            <span
              className="h-3 w-3 shrink-0 rounded-[4px]"
              style={{ background: layerVar(l) }}
              aria-hidden="true"
            />
            <span className="w-[96px] shrink-0 text-[14px] font-semibold">{t(`layer.${l}`)}</span>
            <span className="mono text-[12px] text-muted">{t(`legend.${l}`)}</span>
          </li>
        ))}
        <li className="flex items-center gap-3 border-t border-line pt-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-[4px]"
            style={{ background: layerVar('browser') }}
            aria-hidden="true"
          />
          <span className="w-[96px] shrink-0 text-[14px] font-semibold">{t('layer.browser')}</span>
          <span className="mono text-[12px] text-muted">{t('legend.browser')}</span>
        </li>
      </ul>
    </section>
  );
}
