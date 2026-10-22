import { memo, useMemo } from 'react';
import type { LayerNode } from '@packet-trip/engine';
import { useTranslation } from 'react-i18next';
import { hexVar } from '../design/layer-colors';
import { byteMap, findField } from './inspector-model';

export interface HexDumpProps {
  readonly bytes: Uint8Array;
  readonly layers: readonly LayerNode[];
  /** Highlighted byte range (hovered field or selected layer). */
  readonly highlight: readonly [number, number] | null;
  readonly showAscii: boolean;
  readonly onHoverField: (id: string | null) => void;
  readonly label: string;
}

const hex2 = (b: number): string => b.toString(16).padStart(2, '0');

/** 16 bytes per row on an ink background; each byte tinted by its field's layer. */
export const HexDump = memo(function HexDump({
  bytes,
  layers,
  highlight,
  showAscii,
  onHoverField,
  label,
}: HexDumpProps) {
  const { t } = useTranslation();
  const map = useMemo(() => byteMap(bytes.length, layers), [bytes, layers]);
  const rows = Math.ceil(bytes.length / 16);
  const inHl = (i: number): boolean => highlight !== null && i >= highlight[0] && i < highlight[1];
  const onOver = (e: React.MouseEvent): void => {
    const el = (e.target as HTMLElement).closest('[data-i]');
    if (!el) return;
    const i = Number(el.getAttribute('data-i'));
    onHoverField(map[i]?.fieldId ?? null);
  };
  /* eslint-disable jsx-a11y/mouse-events-have-key-events */
  return (
    // The field list next to the dump is the keyboard-accessible equivalent of hovering bytes.
    <div
      className="mono overflow-x-auto rounded-[12px] p-3 text-[12.5px] leading-[1.7]"
      style={{ background: 'var(--hex-bg)', color: 'var(--hex-fg)' }}
      role="group"
      aria-label={label}
      data-testid="hex-dump"
      onMouseOver={onOver}
      onMouseLeave={() => onHoverField(null)}
    >
      <div className="sr-only">{t('hex.srNote', { n: bytes.length })}</div>
      <div aria-hidden="true" className="w-max">
        {Array.from({ length: rows }, (_, r) => {
          const start = r * 16;
          return (
            <div key={r} className="flex whitespace-pre">
              <span className="mr-4 select-none" style={{ color: 'var(--hex-muted)' }}>
                {start.toString(16).padStart(4, '0')}
              </span>
              <span className="flex">
                {Array.from({ length: 16 }, (_, c) => {
                  const i = start + c;
                  const b = bytes[i];
                  if (b === undefined) return <span key={c} className="inline-block w-[2.6ch]" />;
                  const info = map[i];
                  const hl = inHl(i);
                  return (
                    <span
                      key={c}
                      data-i={i}
                      className={`inline-block w-[2.6ch] text-center ${c === 8 ? 'ml-[1ch]' : ''}`}
                      style={{
                        color: info ? hexVar(info.layer) : 'var(--hex-fg)',
                        opacity: highlight && !hl ? 0.45 : info?.shade ? 0.82 : 1,
                        background: hl
                          ? 'color-mix(in srgb, currentColor 22%, transparent)'
                          : undefined,
                        borderRadius: 3,
                      }}
                    >
                      {hex2(b)}
                    </span>
                  );
                })}
              </span>
              {showAscii && (
                <span className="ml-4 select-none" style={{ color: 'var(--hex-muted)' }}>
                  {Array.from(bytes.subarray(start, start + 16), (b, c) => (
                    <span
                      key={c}
                      data-i={start + c}
                      style={{ color: inHl(start + c) ? 'var(--hex-fg)' : undefined }}
                    >
                      {b >= 32 && b < 127 ? String.fromCharCode(b) : '.'}
                    </span>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
  /* eslint-enable jsx-a11y/mouse-events-have-key-events */
});

export { findField };
