import { motion } from 'motion/react';
import type { DomNode } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';

function attrsText(n: DomNode): string {
  return n.attrs
    .filter(([k]) => ['class', 'id', 'href', 'rel', 'src', 'media'].includes(k))
    .map(([k, v]) => ` ${k}="${v.length > 18 ? `${v.slice(0, 17)}…` : v}"`)
    .join('');
}

function Node({
  n,
  depth,
  selected,
  onSelect,
}: {
  n: DomNode;
  depth: number;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const isSel = selected === n.id;
  const label =
    n.kind === 'text'
      ? `"${n.text.replace(/\s+/g, ' ').trim().slice(0, 36)}${n.text.trim().length > 36 ? '…' : ''}"`
      : n.kind === 'doctype'
        ? `<${n.tag}>`
        : `<${n.tag}${attrsText(n)}>`;
  if (n.kind === 'text' && n.text.trim() === '') return null;
  return (
    <li
      role="treeitem"
      aria-selected={isSel}
      aria-expanded={n.children.length > 0 ? true : undefined}
    >
      <motion.button
        type="button"
        initial={{ opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25 }}
        onClick={() => onSelect(n.id)}
        className={`mono block w-full truncate rounded-md px-1.5 py-0.5 text-left text-[12px] ${isSel ? 'outline outline-2' : 'hover:bg-surface-2'}`}
        style={{
          paddingLeft: 6 + depth * 14,
          color: n.kind === 'text' ? 'var(--muted)' : layerVar('browser'),
          outlineColor: isSel ? layerVar('browser') : undefined,
        }}
      >
        {label}
      </motion.button>
      {n.children.length > 0 && (
        <ul role="group">
          {n.children.map((c) => (
            <Node key={c.id} n={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The live DOM tree, growing as the tokenizer emits nodes. */
export function DomTree({
  root,
  selected,
  onSelect,
}: {
  root: DomNode | null;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const { t } = useFormat();
  if (!root || root.children.length === 0)
    return <p className="text-[13px] text-muted">{t('render.domEmpty')}</p>;
  return (
    <ul role="tree" aria-label={t('render.dom')} className="space-y-0.5">
      {root.children.map((c) => (
        <Node key={c.id} n={c} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}
