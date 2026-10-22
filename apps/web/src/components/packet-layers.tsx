import type { LayerNode, PacketDetail } from '@packet-trip/engine';
import { useTranslation } from 'react-i18next';
import { layerText, layerTint, layerVar } from '../design/layer-colors';
import * as Tooltip from '@radix-ui/react-tooltip';

/** Short label for a layer chip, e.g. "UDP :53". */
export function chipLabel(l: LayerNode): string {
  if (l.id === 'udp' || l.id === 'tcp') {
    const ports = l.facts.find((f) => f.label === 'ports')?.value ?? '';
    const known = ports.split(' → ').find((p) => p === '53' || p === '443');
    return known ? `${l.name} :${known}` : l.name;
  }
  return l.name;
}

/** Wi-Fi · IPv4 · UDP :53 · DNS — click a chip to highlight that layer's bytes. */
export function LayerChips({
  detail,
  active,
  onSelect,
}: {
  detail: PacketDetail;
  active: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const top = detail.layers.filter((l) => l.depth <= 3);
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="toolbar"
      aria-label={t('inspector.layers')}
    >
      {top.map((l, i) => {
        const on = active === l.id;
        const chip = (
          <button
            type="button"
            onClick={() => onSelect(on ? null : l.id)}
            aria-pressed={on}
            className="mono inline-flex h-7 items-center rounded-lg px-2.5 text-[12px] font-semibold"
            style={{
              color: on ? 'var(--tag-fg)' : layerText(l.layer),
              background: on ? layerText(l.layer) : layerTint(l.layer, 9),
              boxShadow: `inset 0 0 0 1px ${on ? layerVar(l.layer) : layerTint(l.layer, 35)}`,
            }}
          >
            {chipLabel(l)}
          </button>
        );
        return (
          <span key={l.id + i} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-muted" aria-hidden="true">
                ·
              </span>
            )}
            {l.id === 'eth' ? (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>{chip}</Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    sideOffset={6}
                    className="panel z-50 max-w-[260px] p-2.5 text-[12px] shadow-lg"
                  >
                    {t('inspector.arpNote')}
                    <Tooltip.Arrow className="fill-[var(--surface)]" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ) : (
              chip
            )}
          </span>
        );
      })}
    </div>
  );
}
