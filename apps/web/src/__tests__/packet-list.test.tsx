import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createSimulation } from '@packet-trip/engine';
import { PacketList } from '../components/packet-list';

const packets = createSimulation({ seed: 42 })
  .getRun()
  .packets.filter((p) => p.connId === 1);

function Harness({ onChange }: { onChange: (id: number) => void }) {
  const [cur, setCur] = useState(packets[0]?.id ?? null);
  return (
    <PacketList
      packets={packets}
      current={cur}
      label="Captured packets"
      onSelect={(id) => {
        setCur(id);
        onChange(id);
      }}
    />
  );
}

describe('packet list keyboard navigation', () => {
  it('moves the selection with arrows, Home and End', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = screen.getByRole('listbox', { name: 'Captured packets' });
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(packets[2]?.id);
    expect(list.getAttribute('aria-activedescendant')).toBe(`pkt-${packets[2]?.id}`);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(packets[1]?.id);
    fireEvent.keyDown(list, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(packets[packets.length - 1]?.id);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(packets[0]?.id);
    const selected = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });
});
