import { en } from '@emporium/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// English only for now; keys live in packages/shared so the mobile app can reuse them.
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

export { i18n };
