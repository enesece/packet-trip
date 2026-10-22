import { useEffect, useState } from 'react';
import type { PacketDetail } from '@packet-trip/engine';
import { getSimClient } from '../worker/client';
import { useSim } from '../state/use-sim';

/** Loads a packet's decoded detail from the worker (cached per run). */
export function usePacket(id: number | null): PacketDetail | null {
  const runId = useSim((v) => v.runId);
  const [detail, setDetail] = useState<PacketDetail | null>(null);
  useEffect(() => {
    let live = true;
    if (id === null) {
      setDetail(null);
      return;
    }
    void getSimClient()
      .getPacket(id)
      .then((d) => {
        if (live) setDetail(d);
      });
    return () => {
      live = false;
    };
  }, [id, runId]);
  return detail;
}
