import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import tr from './tr.json';

function initialLanguage(): 'en' | 'tr' {
  try {
    const saved = localStorage.getItem('pt-lang');
    if (saved === 'en' || saved === 'tr') return saved;
  } catch {
    // storage unavailable
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('tr')
    ? 'tr'
    : 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, tr: { translation: tr } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem('pt-lang', lng);
  } catch {
    // ignore
  }
});

export default i18n;
