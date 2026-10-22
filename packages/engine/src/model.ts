/**
 * Plain, structured-clone-safe types shared by the engine and the web app.
 * Nothing in here is a class, so every value can cross a worker boundary.
 */

export type LayerId = 'application' | 'security' | 'transport' | 'network' | 'link' | 'browser';

export const LAYER_ORDER: readonly LayerId[] = [
  'application',
  'security',
  'transport',
  'network',
  'link',
  'browser',
];

/** A translatable message: a key into en.json / tr.json plus interpolation params. */
export interface Msg {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type ByteRange = readonly [start: number, end: number];

export interface Field {
  /** Stable id within the packet, e.g. "ipv4.ttl". */
  readonly id: string;
  /** English field name (fallback when no translation exists). */
  readonly name: string;
  /** i18n key for the name. */
  readonly nameKey: string;
  /** Interpolation params for the name (e.g. a label number or header name). */
  readonly nameParams?: Readonly<Record<string, string | number>>;
  /** [start, end) offsets into the bytes this field was decoded from. */
  readonly byteRange: ByteRange;
  /** The raw bytes as lowercase hex. */
  readonly raw: string;
  /** Decoded value, formatted for display. */
  readonly display: string;
  /** Plain-language meaning. */
  readonly meaning: Msg;
  /** Hidden in Story mode (sequence numbers, checksums, offsets…). */
  readonly expert: boolean;
  /** Nested sub-fields (e.g. DNS labels inside a name). */
  readonly children?: readonly Field[];
}

export interface LayerNode {
  readonly id: string;
  /** Nesting depth: 0 link, 1 network, 2 transport, 3 record/app, 4 inside a record. */
  readonly depth: number;
  /** Short protocol label, e.g. "IPv4". */
  readonly name: string;
  readonly layer: LayerId;
  readonly byteRange: ByteRange;
  readonly fields: readonly Field[];
  /** One-line summary of the layer's key facts. */
  readonly summary: Msg;
  /** Compact key facts shown in "Inside the packet" boxes. */
  readonly facts: readonly Fact[];
}

export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly expert: boolean;
}

export type NodeId =
  | 'laptop'
  | 'router'
  | 'isp1'
  | 'isp2'
  | 'isp3'
  | 'isp4'
  | 'resolver'
  | 'root'
  | 'tld'
  | 'ns1'
  | 'ns2'
  | 'cdn'
  | 'origin';

export type Direction = 'out' | 'in' | 'other';

export interface HopTime {
  readonly node: NodeId;
  /** When the packet's last bit reached this node (µs). */
  readonly tUs: number;
}

export interface PacketSummary {
  readonly id: number;
  /** Send time at the source (µs). */
  readonly tUs: number;
  /** Arrival time at the destination, or null if it was lost. */
  readonly arriveUs: number | null;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly topLayer: LayerId;
  /** Protocol tag shown in lists, e.g. "DNS", "TCP", "TLS", "HTTP". */
  readonly proto: string;
  readonly name: string;
  readonly nameMsg: Msg;
  /** Frame size in bytes. */
  readonly size: number;
  readonly direction: Direction;
  readonly flow: 'dns' | 'tcp';
  readonly connId: number | null;
  readonly lost: boolean;
  readonly retransmit: boolean;
  readonly encrypted: boolean;
  readonly hops: readonly HopTime[];
  /** Which stop this packet belongs to. */
  readonly stop: StopId;
  /** DNS sequence step number (1–8) for DNS packets. */
  readonly dnsStep: number | null;
  readonly story: Msg;
}

export interface DecryptedRecord {
  /** Index of the record within the TCP stream. */
  readonly recordIndex: number;
  /** Byte range of the encrypted record body inside this packet. */
  readonly ciphertextRange: ByteRange;
  readonly plaintext: Uint8Array;
  readonly innerType: number;
  readonly layers: readonly LayerNode[];
  /** True when the whole record fits in this packet. */
  readonly complete: boolean;
}

export interface PacketDetail {
  readonly summary: PacketSummary;
  readonly bytes: Uint8Array;
  readonly layers: readonly LayerNode[];
  /** Concatenated plaintext of every encrypted record in this packet. */
  readonly plaintext?: Uint8Array;
  readonly decrypted: readonly DecryptedRecord[];
  readonly cryptoMode: CryptoMode;
  /** Where the bytes were captured. */
  readonly capturedAt: NodeId;
}

export type CryptoMode = 'simulated' | 'webcrypto';

export type StopId = 'dns' | 'tcp' | 'tls' | 'request' | 'response' | 'render';

export const STOP_IDS: readonly StopId[] = ['dns', 'tcp', 'tls', 'request', 'response', 'render'];

export interface Stop {
  readonly id: StopId;
  readonly layer: LayerId;
  readonly startUs: number;
  readonly endUs: number;
  readonly state: 'done' | 'current' | 'future';
}

export type EventKind =
  'send' | 'arrive' | 'timeout' | 'parse' | 'paint' | 'cache' | 'state' | 'drop';

export interface SimEvent {
  readonly seq: number;
  readonly tUs: number;
  readonly kind: EventKind;
  readonly layer: LayerId;
  readonly node: NodeId;
  readonly msg: Msg;
  readonly packetId: number | null;
}

export interface DnsCacheEntry {
  readonly where: 'browser' | 'os' | 'resolver';
  readonly name: string;
  readonly type: 'A' | 'NS';
  readonly value: string;
  readonly ttl: number;
  readonly storedUs: number;
  /** Remaining TTL in seconds at the snapshot time. */
  readonly remaining: number;
}

export interface ConnectionInfo {
  readonly id: number;
  readonly client: string;
  readonly server: string;
  readonly state: string;
  readonly clientIsn: number;
  readonly serverIsn: number;
  readonly bytesClientToServer: number;
  readonly bytesServerToClient: number;
  readonly cwndSegments: number;
  readonly retransmits: number;
  readonly label: string;
}

export interface DomNode {
  readonly id: number;
  readonly kind: 'document' | 'doctype' | 'element' | 'text';
  readonly tag: string;
  readonly attrs: readonly (readonly [string, string])[];
  readonly text: string;
  readonly children: readonly DomNode[];
  readonly createdUs: number;
}

export interface LayoutBox {
  readonly nodeId: number;
  readonly tag: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly kind: 'block' | 'line' | 'text';
}

export type DisplayItem =
  | {
      readonly kind: 'rect';
      readonly nodeId: number;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly color: string;
      readonly radius: number;
    }
  | {
      readonly kind: 'text';
      readonly nodeId: number;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly baseline: number;
      readonly text: string;
      readonly color: string;
      readonly fontFamily: string;
      readonly fontSize: number;
      readonly fontWeight: number;
      readonly underline: boolean;
    };

export interface ResourceTiming {
  readonly url: string;
  readonly kind: 'document' | 'stylesheet' | 'script' | 'font';
  readonly requestUs: number;
  readonly firstByteUs: number;
  readonly doneUs: number;
  readonly bytes: number;
  readonly renderBlocking: boolean;
  readonly cache: 'HIT' | 'MISS' | 'NONE';
}

export type PipelineStep = 'html' | 'css' | 'style' | 'layout' | 'paint' | 'composite';

export interface RenderState {
  readonly domTree: DomNode | null;
  readonly layoutBoxes: readonly LayoutBox[];
  readonly displayList: readonly DisplayItem[];
  readonly resources: readonly ResourceTiming[];
  readonly firstPaintUs: number | null;
  readonly loadUs: number | null;
  readonly domContentLoadedUs: number | null;
  readonly fontSwapUs: number | null;
  readonly painted: boolean;
  readonly fontLoaded: boolean;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly pipeline: Readonly<Record<PipelineStep, 'done' | 'current' | 'future'>>;
  readonly pipelineTimes: Readonly<Record<PipelineStep, number | null>>;
  readonly htmlBytesParsed: number;
  readonly cssRules: number;
}

export interface SimSnapshot {
  readonly seed: number;
  readonly config: ScenarioConfig;
  readonly nowUs: number;
  readonly endUs: number;
  /** Index of the last processed log event (−1 before the first). */
  readonly cursor: number;
  readonly stops: readonly Stop[];
  readonly packets: readonly PacketSummary[];
  /** Number of packets whose send time is ≤ nowUs. */
  readonly packetsSent: number;
  readonly events: readonly SimEvent[];
  readonly dnsCache: readonly DnsCacheEntry[];
  readonly connections: readonly ConnectionInfo[];
  readonly render: RenderState;
  readonly marks: {
    readonly dnsDoneUs: number | null;
    readonly connectedUs: number | null;
    readonly tlsDoneUs: number | null;
    readonly firstByteUs: number | null;
    readonly firstPaintUs: number | null;
    readonly loadUs: number | null;
  };
  readonly cryptoMode: CryptoMode;
  readonly site: SiteInfo;
  readonly dnsLanes: readonly DnsLane[];
  readonly nodes: readonly NodeInfo[];
  readonly links: readonly LinkInfo[];
}

export interface DnsLane {
  readonly node: NodeId;
  readonly label: string;
  readonly address: string;
}

export interface NodeInfo {
  readonly id: NodeId;
  readonly name: string;
  readonly address: string;
  readonly mac: string;
}

export interface LinkInfo {
  readonly a: NodeId;
  readonly b: NodeId;
  readonly latencyUs: number;
  readonly bandwidthBps: number;
}

export interface SiteInfo {
  readonly host: string;
  readonly title: string;
  readonly cdn: boolean;
  readonly serverAddress: string;
}

export type SiteId = 'example.com' | 'static.example' | 'far.example' | 'heavy.example';

export type DnsWarmth = 'cold' | 'resolver' | 'browser';

export interface ScenarioConfig {
  readonly seed: number;
  readonly site: SiteId;
  /** Multiplies every link latency. 1 = default. */
  readonly rttScale: number;
  /** 0–0.1. Applied to TCP segments on the ISP access link. */
  readonly lossRate: number;
  readonly tlsVersion: '1.2' | '1.3';
  readonly httpVersion: '1.1' | '2';
  readonly cdn: boolean;
  /**
   * DNS cache warmth. "cold": nothing cached. "resolver": the resolver has the
   * answer (steps 2–7 skipped). "browser": the browser has it (no DNS packets).
   */
  readonly warmDnsCache: DnsWarmth;
  readonly ns1Timeout: boolean;
  readonly inlineCriticalCss: boolean;
}

export const DEFAULT_CONFIG: ScenarioConfig = {
  seed: 42,
  site: 'example.com',
  rttScale: 1,
  lossRate: 0,
  tlsVersion: '1.3',
  httpVersion: '1.1',
  cdn: true,
  warmDnsCache: 'cold',
  ns1Timeout: false,
  inlineCriticalCss: false,
};
