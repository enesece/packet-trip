import { memo, useMemo } from 'react';
import type { LayerNode } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';
import { flatten } from './inspector-model';

export interface FieldListProps {
  readonly layers: readonly LayerNode[];
  readonly expert: boolean;
  readonly hoverField: string | null;
  readonly onHoverField: (id: string | null) => void;
}

/** Color chip, name, raw value and meaning for every field; hovering syncs with the hex dump. */
export const FieldList = memo(function FieldList({
  layers,
  expert,
  hoverField,
  onHoverField,
}: FieldListProps) {
  const { t, msg } = useFormat();
  const rows = useMemo(() => flatten(layers, expert), [layers, expert]);
  let lastLayer = '';
  return (
    <ul
      className="divide-y divide-line"
      data-testid="field-list"
      onMouseLeave={() => onHoverField(null)}
    >
      {rows.map(({ field: f, layer, depth }) => {
        const header = layer.id !== lastLayer;
        lastLayer = layer.id;
        const active = hoverField === f.id;
        return (
          <li key={`${layer.id}:${f.id}`} className={header ? 'pt-3 first:pt-0' : ''}>
            {header && (
              <p className="eyebrow mb-1.5 flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: layerVar(layer.layer) }}
                  aria-hidden="true"
                />
                {layer.name}
                {expert && (
                  <span className="normal-case tracking-normal">
                    · {t('fields.offset', { from: layer.byteRange[0], to: layer.byteRange[1] })}
                  </span>
                )}
              </p>
            )}
            <button
              type="button"
              className={`grid w-full grid-cols-[10px_minmax(0,1fr)] gap-x-3 rounded-lg px-2 py-2 text-left ${active ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onMouseEnter={() => onHoverField(f.id)}
              onFocus={() => onHoverField(f.id)}
              onBlur={() => onHoverField(null)}
              aria-describedby={`m-${layer.id}-${f.id}`}
              data-field={f.id}
              aria-pressed={active}
            >
              <span
                className="mt-1.5 h-2.5 w-2.5 rounded-[3px]"
                style={{ background: layerVar(layer.layer), opacity: depth > 0 ? 0.6 : 1 }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-semibold">
                    {t(f.nameKey, { defaultValue: f.name })}
                  </span>
                  <span className="mono min-w-0 break-all text-[12px]">{f.display}</span>
                  {expert && (
                    <span className="mono text-[11px] text-muted">
                      [{f.byteRange[0]}–{f.byteRange[1]}){' '}
                      {f.raw.length > 24 ? `${f.raw.slice(0, 24)}…` : f.raw}
                    </span>
                  )}
                </span>
                <span
                  id={`m-${layer.id}-${f.id}`}
                  className="mt-0.5 block text-[12.5px] leading-snug text-muted"
                >
                  {msg(f.meaning)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
