import { useEffect, useRef } from 'react';
import type { PacketSummary } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';
import { LayerTag } from './ui/layer-tag';

export interface PacketListProps {
  readonly packets: readonly PacketSummary[];
  readonly current: number | null;
  readonly onSelect: (id: number) => void;
  readonly label: string;
}

/**
 * "Captured packets": one row per packet. The list is a listbox: ↑/↓, Home/End move the selection.
 * Current row: 2 px border in its layer color; earlier rows: 1 px neutral; later rows: dashed, muted.
 */
export function PacketList({ packets, current, onSelect, label }: PacketListProps) {
  const { t, msg } = useFormat();
  const listRef = useRef<HTMLUListElement | null>(null);
  const idx = packets.findIndex((p) => p.id === current);
  const curT = packets[idx]?.tUs ?? -1;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const onKey = (e: React.KeyboardEvent): void => {
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(packets.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = packets.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const p = packets[next];
    if (p) onSelect(p.id);
  };

  return (
    <ul
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={current !== null ? `pkt-${current}` : undefined}
      onKeyDown={onKey}
      className="space-y-1.5 rounded-[12px] outline-offset-4"
      data-testid="packet-list"
    >
      {packets.map((p) => {
        const state =
          p.id === current
            ? 'current'
            : p.tUs < curT || (p.tUs === curT && p.id < (current ?? 0))
              ? 'done'
              : 'future';
        const cls =
          state === 'current'
            ? 'state-current bg-surface'
            : state === 'done'
              ? 'state-done bg-surface'
              : 'state-future text-muted';
        return (
          // Keyboard selection is handled by the listbox (aria-activedescendant pattern).
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <li
            key={p.id}
            id={`pkt-${p.id}`}
            data-id={p.id}
            role="option"
            aria-selected={p.id === current}
            onClick={() => onSelect(p.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 ${cls} ${state === 'future' ? 'opacity-70' : ''}`}
            style={state === 'current' ? { borderColor: layerVar(p.topLayer) } : undefined}
          >
            <span className="mono w-7 shrink-0 text-right text-[11px] text-muted">{p.id}</span>
            <LayerTag layer={p.topLayer} filled={state !== 'future'} className="shrink-0">
              {p.proto}
            </LayerTag>
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${state === 'current' ? 'font-semibold' : ''}`}
            >
              {msg(p.nameMsg) || p.name}
            </span>
            {p.lost && (
              <span className="text-[11px] font-semibold text-danger" title={t('handshake.lost')}>
                ✕
              </span>
            )}
            <span
              className="mono shrink-0 text-[13px] text-muted"
              aria-label={p.direction === 'out' ? t('dir.out') : t('dir.in')}
            >
              {p.direction === 'out' ? '→' : '←'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
