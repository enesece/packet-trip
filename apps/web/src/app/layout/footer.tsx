import { useTranslation } from 'react-i18next';

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="mx-auto max-w-[1320px] px-4 pb-6 pt-10 text-[13px] text-muted">
      <p>{t('footer.note')}</p>
    </footer>
  );
}
