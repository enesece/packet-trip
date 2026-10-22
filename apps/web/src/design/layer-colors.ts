import type { LayerId } from '@packet-trip/engine';

/** One fixed color per layer, used for wires, tags, hex highlights, timeline ticks and borders. */
export const LAYER_HEX: Readonly<Record<LayerId, string>> = {
  application: '#C2410C',
  security: '#6741D9',
  transport: '#1971C2',
  network: '#2B8A3E',
  link: '#495057',
  browser: '#C2255C',
};

/** CSS variable for a layer color; follows the active theme. */
export const layerVar = (l: LayerId): string => `var(--layer-${l})`;

/** Lighter variant used on the always-dark hex dump. */
export const hexVar = (l: LayerId): string => `var(--hex-${l})`;

/** Translucent tint of a layer color (works in both themes). */
export const layerTint = (l: LayerId, pct: number): string =>
  `color-mix(in srgb, var(--layer-${l}) ${pct}%, transparent)`;

export const LAYERS_TOP_DOWN: readonly LayerId[] = [
  'application',
  'security',
  'transport',
  'network',
  'link',
];

/** Layer color for text: identical to the layer color except where contrast needs a darker shade. */
export const layerText = (l: LayerId): string => `var(--text-${l}, var(--layer-${l}))`;
