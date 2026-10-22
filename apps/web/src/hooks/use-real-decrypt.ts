import { useEffect, useState } from 'react';
import type { PacketDetail, RealDecryptResult } from '@packet-trip/engine';
import { getSimClient } from '../worker/client';

/** With real Web Crypto keys, ask the worker to actually run AES-GCM on the record bytes. */
export function useRealDecrypt(detail: PacketDetail | null, on: boolean): RealDecryptResult | null {
  const [res, setRes] = useState<RealDecryptResult | null>(null);
  useEffect(() => {
    let live = true;
    setRes(null);
    if (!on || !detail || detail.cryptoMode !== 'webcrypto' || detail.decrypted.length === 0)
      return;
    void getSimClient()
      .decrypt(detail.summary.id)
      .then((r) => {
        if (live) setRes(r);
      });
    return () => {
      live = false;
    };
  }, [detail, on]);
  return res;
}
