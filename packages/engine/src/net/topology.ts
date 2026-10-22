import type { LinkInfo, NodeId, NodeInfo } from '../model';
import type { SiteDef } from '../content/sites';

/** All addresses come from documentation ranges (RFC 5737, RFC 7042 locally administered MACs). */
export interface NodeDef extends NodeInfo {
  readonly router: boolean;
}

export function buildNodes(site: SiteDef): Record<NodeId, NodeDef> {
  const n = (id: NodeId, name: string, address: string, mac: string, router = false): NodeDef => ({
    id,
    name,
    address,
    mac,
    router,
  });
  return {
    laptop: n('laptop', 'Your laptop', '192.168.1.24', '02:00:5e:10:00:24'),
    router: n('router', 'Home router', '192.168.1.1', '02:00:5e:10:00:01', true),
    isp1: n('isp1', 'ISP hop 1', '198.51.100.1', '02:00:5e:10:01:01', true),
    isp2: n('isp2', 'ISP hop 2', '198.51.100.2', '02:00:5e:10:01:02', true),
    isp3: n('isp3', 'ISP hop 3', '198.51.100.3', '02:00:5e:10:01:03', true),
    isp4: n('isp4', 'ISP hop 4', '198.51.100.4', '02:00:5e:10:01:04', true),
    resolver: n('resolver', 'DNS resolver', '198.51.100.53', '02:00:5e:10:00:53'),
    root: n('root', 'Root server', '192.0.2.1', '02:00:5e:10:02:01'),
    tld: n('tld', site.tldServer, '192.0.2.30', '02:00:5e:10:02:30'),
    ns1: n('ns1', site.nsHosts[0], '192.0.2.53', '02:00:5e:10:02:53'),
    ns2: n('ns2', site.nsHosts[1], '192.0.2.54', '02:00:5e:10:02:54'),
    cdn: n('cdn', 'CDN edge', '203.0.113.10', '02:00:5e:10:03:10'),
    origin: n('origin', 'Origin server', '203.0.113.80', '02:00:5e:10:03:80'),
  };
}

export interface LinkDef {
  readonly a: NodeId;
  readonly b: NodeId;
  readonly latencyUs: number;
  readonly jitterUs: number;
  readonly bandwidthBps: number;
  /** Packet loss (TCP only) is applied on this link. */
  readonly lossy: boolean;
}

const MBPS = 1_000_000;

export function buildLinks(site: SiteDef, rttScale: number): LinkDef[] {
  const l = (
    a: NodeId,
    b: NodeId,
    ms: number,
    jitterMs: number,
    mbps: number,
    lossy = false,
  ): LinkDef => ({
    a,
    b,
    latencyUs: Math.round(ms * 1000 * rttScale),
    jitterUs: Math.round(jitterMs * 1000 * rttScale),
    bandwidthBps: mbps * MBPS,
    lossy,
  });
  return [
    l('laptop', 'router', 1, 0.15, 300),
    l('router', 'isp1', 1, 0.2, 20, true),
    l('isp1', 'isp2', 1, 0.1, 1000),
    l('isp2', 'isp3', 1, 0.1, 1000),
    l('isp3', 'isp4', 1, 0.1, 1000),
    l('isp4', 'resolver', 6, 0.3, 1000),
    l('resolver', 'root', 8, 0.4, 1000),
    l('resolver', 'tld', 10, 0.4, 1000),
    l('resolver', 'ns1', 12, 0.5, 1000),
    l('resolver', 'ns2', 11, 0.5, 1000),
    l('isp4', 'cdn', 7, 0.3, 1000),
    l('cdn', 'origin', site.originLatencyMs, 1, 1000),
    l('isp4', 'origin', 7 + site.originLatencyMs, 1, 1000),
  ];
}

/** Shortest path by hop count (BFS); the graph is tiny. */
export function route(links: readonly LinkDef[], from: NodeId, to: NodeId): NodeId[] {
  const adj = new Map<NodeId, NodeId[]>();
  for (const k of links) {
    adj.set(k.a, [...(adj.get(k.a) ?? []), k.b]);
    adj.set(k.b, [...(adj.get(k.b) ?? []), k.a]);
  }
  const prev = new Map<NodeId, NodeId>();
  const seen = new Set<NodeId>([from]);
  const q: NodeId[] = [from];
  while (q.length) {
    const cur = q.shift() as NodeId;
    if (cur === to) break;
    for (const nb of adj.get(cur) ?? []) {
      if (seen.has(nb)) continue;
      // Endpoints never forward traffic, except the resolver toward the name servers.
      seen.add(nb);
      prev.set(nb, cur);
      q.push(nb);
    }
  }
  const path: NodeId[] = [to];
  let c = to;
  while (c !== from) {
    const p = prev.get(c);
    if (!p) throw new Error(`no route ${from} → ${to}`);
    path.unshift(p);
    c = p;
  }
  return path;
}

export function linkInfo(links: readonly LinkDef[]): LinkInfo[] {
  return links.map((k) => ({
    a: k.a,
    b: k.b,
    latencyUs: k.latencyUs,
    bandwidthBps: k.bandwidthBps,
  }));
}
