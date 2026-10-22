import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { MotionConfig } from 'motion/react';
import { useUi } from '../state/ui-store';
import { getSimClient } from '../worker/client';
import { configFromSearch, searchFromConfig } from './url-state';
import { measureFontTable } from './fonts';
import { loadRun, startPlaybackEngine } from './controller';

/** Applies the theme to <html> and persists it. */
function useThemeEffect(): void {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') delete el.dataset.theme;
    else el.dataset.theme = theme;
    try {
      localStorage.setItem('pt-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);
}

/** Reads ?seed=…&packet=… once, measures fonts, loads the first run, starts playback. */
function useBootstrap(): void {
  const loc = useLocation();
  const booted = useRef(false);
  useEffect(() => startPlaybackEngine(), []);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const { config, packet, tMs } = configFromSearch(loc.search);
    useUi.getState().set({ config, selectedPacket: packet });
    void (async () => {
      const table = await measureFontTable();
      if (table) await getSimClient().setFontTable(table);
      await loadRun({ config });
      if (packet !== null) {
        const p = getSimClient().getView().run?.packets[packet - 1];
        if (p) useUi.getState().set({ playheadUs: p.tUs, started: true });
      } else if (tMs !== null) {
        useUi.getState().set({ playheadUs: Math.round(tMs * 1000), started: true });
      }
    })();
  }, [loc.search]);
}

/** Keeps the URL in sync with the seed, config and selected packet (shareable moments). */
function useUrlSync(): void {
  const navigate = useNavigate();
  const loc = useLocation();
  const config = useUi((s) => s.config);
  const packet = useUi((s) => s.selectedPacket);
  useEffect(() => {
    const search = searchFromConfig(
      config,
      loc.pathname.startsWith('/handshake') || loc.pathname.startsWith('/dns') ? packet : null,
    );
    if (search !== loc.search)
      void navigate({ pathname: loc.pathname, search, hash: loc.hash }, { replace: true });
  }, [config, packet, loc.pathname, loc.search, loc.hash, navigate]);
}

export function Providers({ children }: { children: React.ReactNode }) {
  useThemeEffect();
  useBootstrap();
  useUrlSync();
  return (
    <MotionConfig reducedMotion="user">
      <Tooltip.Provider delayDuration={200}>{children}</Tooltip.Provider>
    </MotionConfig>
  );
}
