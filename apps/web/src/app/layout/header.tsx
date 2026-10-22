import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { Link, NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Logo } from '../../components/ui/logo';
import { IconMonitor, IconMoon, IconSun } from '../../components/ui/icons';
import { useUi, type Mode, type Theme } from '../../state/ui-store';

const segBase =
  'h-7 px-2.5 text-[13px] font-semibold rounded-[7px] text-muted data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_0_0_1px_var(--border-strong)]';

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-2 p-0.5"
    >
      {items.map((it) => (
        <ToggleGroup.Item key={it.value} value={it.value} className={segBase} aria-label={it.label}>
          {it.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Header() {
  const { t, i18n } = useTranslation();
  const mode = useUi((s) => s.mode);
  const theme = useUi((s) => s.theme);
  const set = useUi((s) => s.set);
  const loc = useLocation();
  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconMonitor;
  const setMode = (m: Mode): void => {
    set({ mode: m });
    try {
      localStorage.setItem('pt-mode', m);
    } catch {
      // ignore
    }
  };
  const navCls = ({ isActive }: { isActive: boolean }): string =>
    `px-2.5 py-1.5 rounded-lg text-[14px] font-semibold ${isActive ? 'text-ink' : 'text-muted hover:text-ink'}`;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ground/90 backdrop-blur supports-[backdrop-filter]:bg-ground/75">
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:gap-5">
        <Link
          to={`/journey${loc.search}`}
          className="flex items-center gap-2.5 rounded-lg"
          aria-label={t('nav.home')}
        >
          <Logo />
          <span className="mono hidden text-[13px] font-bold tracking-[0.14em] sm:inline">
            PACKET TRIP
          </span>
        </Link>
        <nav aria-label={t('nav.label')} className="hidden items-center gap-1 md:flex">
          <NavLink to={`/journey${loc.search}`} className={navCls} end>
            {t('nav.journey')}
          </NavLink>
          <a
            href="#map"
            className={navCls({ isActive: false })}
            onClick={(e) => goTo(e, 'map', loc.pathname)}
          >
            {t('nav.map')}
          </a>
          <a
            href="#layers"
            className={navCls({ isActive: false })}
            onClick={(e) => goTo(e, 'layers', loc.pathname)}
          >
            {t('nav.layers')}
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<Mode>
            label={t('mode.label')}
            value={mode}
            onChange={setMode}
            items={[
              { value: 'story', label: t('mode.story') },
              { value: 'expert', label: t('mode.expert') },
            ]}
          />
          <Segmented<'en' | 'tr'>
            label={t('lang.label')}
            value={i18n.language.startsWith('tr') ? 'tr' : 'en'}
            onChange={(l) => void i18n.changeLanguage(l)}
            items={[
              { value: 'en', label: 'EN' },
              { value: 'tr', label: 'TR' },
            ]}
          />
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => set({ theme: nextTheme[theme] })}
            aria-label={t('theme.toggle', { theme: t(`theme.${theme}`) })}
            title={t('theme.toggle', { theme: t(`theme.${theme}`) })}
          >
            <ThemeIcon size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}

function goTo(e: React.MouseEvent, id: string, path: string): void {
  if (!path.startsWith('/journey')) {
    // Let the router-less hash link fall through to the journey page.
    e.preventDefault();
    window.location.assign(`/journey${window.location.search}#${id}`);
    return;
  }
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
}
