import type { LayerId, StopId } from '@packet-trip/engine';

export const STOP_META: Readonly<Record<StopId, { layer: LayerId; route: string; n: number }>> = {
  dns: { layer: 'application', route: '/dns', n: 1 },
  tcp: { layer: 'transport', route: '/handshake', n: 2 },
  tls: { layer: 'security', route: '/handshake', n: 3 },
  request: { layer: 'application', route: '/handshake', n: 4 },
  response: { layer: 'application', route: '/handshake', n: 5 },
  render: { layer: 'browser', route: '/render', n: 6 },
};
