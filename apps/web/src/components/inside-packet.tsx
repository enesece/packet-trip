import type {
  DecryptedRecord,
  LayerNode,
  PacketDetail,
  RealDecryptResult,
} from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerTint, layerVar } from '../design/layer-colors';

interface TreeNode {
  readonly layer: LayerNode;
  readonly children: TreeNode[];
}

/** Turns the flat, depth-annotated layer list into nested boxes. */
export function layerTree(layers: readonly LayerNode[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const l of layers) {
    const node: TreeNode = { layer: l, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.layer.depth ?? -1) >= l.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function recordIndexOf(id: string): number | null {
  const m = /^tls\.(?:r|cont\.)(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

const dec = new TextDecoder();

function Box({
  node,
  expert,
  decrypt,
  decrypted,
  real,
  mode,
}: {
  node: TreeNode;
  expert: boolean;
  decrypt: boolean;
  decrypted: ReadonlyMap<number, DecryptedRecord>;
  real: RealDecryptResult | null;
  mode: PacketDetail['cryptoMode'];
}) {
  const { msg, t, ref } = useFormat();
  const l = node.layer;
  const facts = l.facts.filter((f) => expert || !f.expert);
  const ri = recordIndexOf(l.id);
  const d = ri !== null ? decrypted.get(ri) : undefined;
  return (
    <div
      className="rounded-[10px] p-2.5"
      style={{ border: `1.5px solid ${layerVar(l.layer)}`, background: layerTint(l.layer, 6) }}
      data-layer={l.layer}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-semibold" style={{ color: layerVar(l.layer) }}>
          {t(`layername.${l.name}`, { defaultValue: l.name })}
        </span>
        <span className="text-[12px] text-muted">{msg(l.summary)}</span>
      </div>
      {facts.length > 0 && (
        <dl className="mono mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11.5px]">
          {facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted">{t(`fact.${f.label}`, { defaultValue: f.label })}</dt>
              <dd className="m-0 break-all">{ref(f.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {d && decrypt && (
        <DecryptedBox
          d={d}
          real={real?.records.find((r) => r.recordIndex === d.recordIndex) ?? null}
          expert={expert}
        />
      )}
      {node.children.length > 0 && (
        <div className="mt-2 space-y-2" style={{ marginLeft: 14 }}>
          {node.children.map((c) => (
            <Box
              key={c.layer.id}
              node={c}
              expert={expert}
              decrypt={decrypt}
              decrypted={decrypted}
              real={real}
              mode={mode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DecryptedBox({
  d,
  real,
  expert,
}: {
  d: DecryptedRecord;
  real: RealDecryptResult['records'][number] | null;
  expert: boolean;
}) {
  const { t, msg } = useFormat();
  // TLS 1.3 appends the real content type byte; TLS 1.2 does not.
  const hasInnerType = d.layers.some((l) => l.id.endsWith('.inner'));
  const content = hasInnerType ? d.plaintext.subarray(0, d.plaintext.length - 1) : d.plaintext;
  const text = d.innerType === 23 ? dec.decode(content.subarray(0, 600)) : null;
  return (
    <div
      className="mt-2 rounded-[8px] p-2.5"
      style={{
        marginLeft: 14,
        border: '1.5px dashed var(--layer-security)',
        background: layerTint('security', 8),
      }}
      data-testid="decrypted"
    >
      <p className="text-[12px] font-semibold" style={{ color: 'var(--layer-security)' }}>
        {real ? t('decrypt.real', { key: real.key.slice(0, 16) }) : t('decrypt.simulated')}
        {!d.complete && <span className="font-normal text-muted"> · {t('decrypt.partial')}</span>}
      </p>
      {real && expert && (
        <p className="mono mt-1 break-all text-[11px] text-muted">
          {t('decrypt.nonce')} {real.nonce} ·{' '}
          {real.matches ? t('decrypt.matches') : t('decrypt.mismatch')}
        </p>
      )}
      {d.layers.map((l) => (
        <div key={l.id} className="mt-1.5">
          <p className="text-[12px] font-semibold" style={{ color: 'var(--layer-security)' }}>
            {l.name} <span className="font-normal text-muted">{msg(l.summary)}</span>
          </p>
          {l.facts.length > 0 && (
            <p className="mono text-[11.5px]">
              {l.facts
                .filter((f) => expert || !f.expert)
                .map((f) => `${f.label}: ${f.value}`)
                .join(' · ')}
            </p>
          )}
        </div>
      ))}
      {text !== null && (
        <pre
          className="mono mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md p-2 text-[11.5px] leading-snug"
          style={{ background: 'var(--surface)', color: 'var(--layer-security)' }}
          data-testid="plaintext"
        >
          {text}
          {content.length > 600 ? '…' : ''}
        </pre>
      )}
    </div>
  );
}

/** "Inside the packet": nested boxes Wi-Fi → IPv4 → TCP → TLS record → HTTP / handshake data. */
export function InsidePacket({
  detail,
  expert,
  decrypt,
  real,
}: {
  detail: PacketDetail;
  expert: boolean;
  decrypt: boolean;
  real: RealDecryptResult | null;
}) {
  const tree = layerTree(detail.layers);
  const decrypted = new Map(detail.decrypted.map((d) => [d.recordIndex, d]));
  return (
    <div className="space-y-2" data-testid="inside-packet">
      {tree.map((n) => (
        <Box
          key={n.layer.id}
          node={n}
          expert={expert}
          decrypt={decrypt}
          decrypted={decrypted}
          real={real}
          mode={detail.cryptoMode}
        />
      ))}
    </div>
  );
}
