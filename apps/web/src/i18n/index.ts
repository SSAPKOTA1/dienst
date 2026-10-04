import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './de.json';
import en from './en.json';
import { extraEn } from './extra-en';

const stored = (() => {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: { ...de } },
    en: { translation: { ...en, ...extraEn } },
  },
  lng: stored === 'en' ? 'en' : 'de',
  fallbackLng: 'de',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export function setLang(lng: 'de' | 'en') {
  try {
    localStorage.setItem('lang', lng);
  } catch {
    /* ignore */
  }
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
}

export default i18n;
