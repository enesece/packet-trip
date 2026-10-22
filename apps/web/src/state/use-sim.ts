import { useSyncExternalStore } from 'react';
import { getSimClient, type SimView } from '../worker/client';

/** React adapter over the worker client's external store. */
export function useSim<T>(select: (v: SimView) => T): T {
  const c = getSimClient();
  return useSyncExternalStore(
    c.subscribe,
    () => select(c.getView()),
    () => select(c.getView()),
  );
}

export const useRun = () => useSim((v) => v.run);
export const useSimState = () => useSim((v) => v.state);
