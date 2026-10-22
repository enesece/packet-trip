import { useCallback, useMemo } from 'react';
import type { PacketDetail } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { useUi } from '../state/ui-store';
import { HexDump } from './hex-dump';
import { FieldList } from './field-list';
import { LayerChips } from './packet-layers';
import { findField } from './inspector-model';

/** Title, layer chips, hex dump and field list with two-way hover sync. */
export function PacketInspector({
  detail,
  titleKey,
}: {
  detail: PacketDetail | null;
  titleKey: string;
}) {
  const { t, bytes } = useFormat();
  const mode = useUi((s) => s.mode);
  const hoverField = useUi((s) => s.hoverField);
  const activeLayer = useUi((s) => s.activeLayer);
  const set = useUi((s) => s.set);
  const expert = mode === 'expert';

  const onHoverField = useCallback((id: string | null) => set({ hoverField: id }), [set]);
  const highlight = useMemo((): readonly [number, number] | null => {
    if (!detail) return null;
    if (hoverField) {
      const f = findField(detail.layers, hoverField);
      if (f) return f.byteRange;
    }
    if (activeLayer) {
      const l = detail.layers.find((x) => x.id === activeLayer);
      if (l) return l.byteRange;
    }
    return null;
  }, [detail, hoverField, activeLayer]);

  if (!detail) {
    return (
      <div className="panel flex min-h-[240px] items-center justify-center p-6 text-[14px] text-muted">
        {t('inspector.empty')}
      </div>
    );
  }
  const s = detail.summary;
  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="insp-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="insp-title" className="text-[16px] font-semibold">
          {t(titleKey, { n: s.id, kind: s.name })}
        </h2>
        <p className="mono text-[12px] text-muted">
          {t('inspector.size', { size: bytes(detail.bytes.length) })} ·{' '}
          {t('inspector.captured', { at: t(`node.${detail.capturedAt}`) })}
        </p>
      </div>
      <div className="mt-3">
        <LayerChips
          detail={detail}
          active={activeLayer}
          onSelect={(id) => set({ activeLayer: id })}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[auto_minmax(0,1fr)]">
        <div className="min-w-0">
          <HexDump
            bytes={detail.bytes}
            layers={detail.layers}
            highlight={highlight}
            showAscii={expert}
            onHoverField={onHoverField}
            label={t('hex.label', { n: s.id })}
          />
        </div>
        <div className="min-w-0 xl:max-h-[520px] xl:overflow-auto">
          <FieldList
            layers={detail.layers}
            expert={expert}
            hoverField={hoverField}
            onHoverField={onHoverField}
          />
        </div>
      </div>
    </section>
  );
}
