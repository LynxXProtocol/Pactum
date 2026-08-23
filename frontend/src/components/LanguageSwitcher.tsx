import { useTranslation } from 'react-i18next';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const toggleLanguage = () => {
    const next = i18n.language === 'en' ? 'es' : 'en';
    i18n.changeLanguage(next);
  };

  return (
    <button
      className="language-switcher"
      onClick={toggleLanguage}
      title={i18n.language === 'en' ? 'Switch to Spanish' : 'Cambiar a Inglés'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        fontSize: '12px',
        fontWeight: 600,
        background: 'var(--bg-secondary, #f0f0f0)',
        color: 'var(--text-secondary, #666)',
        border: '1px solid var(--border-color, #e0e0e0)',
        borderRadius: '6px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: '14px' }}>
        {i18n.language === 'en' ? '🇪🇸' : '🇬🇧'}
      </span>
      {i18n.language === 'en' ? 'ES' : 'EN'}
    </button>
  );
}