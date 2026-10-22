import { Outlet } from 'react-router';
import { Header } from './header';
import { Footer } from './footer';
import { Timeline } from '../../components/timeline';
import { Providers } from '../providers';
import { useSim } from '../../state/use-sim';
import { useTranslation } from 'react-i18next';

export function AppLayout() {
  const { t } = useTranslation();
  const error = useSim((v) => v.error);
  return (
    <Providers>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('a11y.skip')}
      </a>
      <Header />
      <main
        id="main"
        className="mx-auto max-w-[1320px] px-4 pt-6"
        style={{ paddingBottom: 'calc(var(--timeline-h) + 8px)' }}
      >
        {error && (
          <p role="alert" className="card mb-4 border-danger p-3 text-[14px] text-danger">
            {t('error.engine', { message: error })}
          </p>
        )}
        <Outlet />
        <Footer />
      </main>
      <Timeline />
    </Providers>
  );
}
