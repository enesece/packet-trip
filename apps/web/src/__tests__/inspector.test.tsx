import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createSimulation } from '@packet-trip/engine';
import * as Tooltip from '@radix-ui/react-tooltip';
import { PacketInspector as Inner } from '../components/packet-inspector';

function PacketInspector(props: React.ComponentProps<typeof Inner>) {
  return (
    <Tooltip.Provider>
      <Inner {...props} />
    </Tooltip.Provider>
  );
}
import { useUi } from '../state/ui-store';

const sim = createSimulation({ seed: 42 });
const detail = sim.getPacket(1);

describe('hex dump ↔ field list hover sync', () => {
  it('hovering a field highlights exactly its bytes', () => {
    useUi.setState({ hoverField: null, activeLayer: null, mode: 'story' });
    render(<PacketInspector detail={detail} titleKey="dns.inspector.query" />);
    const list = screen.getByTestId('field-list');
    const ttl = within(list).getByText('Time to live').closest('button');
    expect(ttl).not.toBeNull();
    fireEvent.mouseEnter(ttl as HTMLElement);
    expect(useUi.getState().hoverField).toBe('ipv4.ttl');
    const hex = screen.getByTestId('hex-dump');
    // TTL is byte 22 of the frame: it is highlighted, its neighbours are not.
    const b22 = hex.querySelector('[data-i="22"]') as HTMLElement;
    const b21 = hex.querySelector('[data-i="21"]') as HTMLElement;
    expect(b22.style.background).not.toBe('');
    expect(b21.style.background).toBe('');
  });

  it('hovering a byte selects its field in the list', () => {
    useUi.setState({ hoverField: null, activeLayer: null });
    render(<PacketInspector detail={detail} titleKey="dns.inspector.query" />);
    const hex = screen.getAllByTestId('hex-dump')[0] as HTMLElement;
    // Bytes 42–43 are the DNS transaction ID.
    fireEvent.mouseOver(hex.querySelector('[data-i="42"]') as HTMLElement);
    expect(useUi.getState().hoverField).toBe('dns.id');
    const row = document.querySelector('[data-field="dns.id"]');
    expect(row?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides expert-only fields in Story mode and shows them in Expert mode', () => {
    useUi.setState({ mode: 'story' });
    const { unmount } = render(<PacketInspector detail={detail} titleKey="dns.inspector.query" />);
    expect(document.querySelector('[data-field="ipv4.csum"]')).toBeNull();
    unmount();
    useUi.setState({ mode: 'expert' });
    render(<PacketInspector detail={detail} titleKey="dns.inspector.query" />);
    expect(document.querySelector('[data-field="ipv4.csum"]')).not.toBeNull();
  });
});
