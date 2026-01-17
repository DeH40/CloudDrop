/**
 * CloudDrop - i18n (Internationalization) Module
 * Lightweight i18n implementation without external dependencies
 */

export class I18n {
  constructor() {
    this.locale = 'zh'; // Default locale
    this.fallbackLocale = 'zh';
    this.translations = {};
    this.supportedLocales = ['en', 'zh', 'ja'];
  }

  /**
   * Initialize i18n system
   * @param {Object} options - Initialization options
   * @param {string} options.defaultLocale - Default locale (default: 'zh')
   * @param {string} options.fallbackLocale - Fallback locale (default: 'zh')
   * @param {Array<string>} options.supportedLocales - Supported locales
   */
  async init(options = {}) {
    this.fallbackLocale = options.fallbackLocale || 'zh';
    this.supportedLocales = options.supportedLocales || ['en', 'zh', 'ja'];

    // Detect locale: URL param > localStorage > browser language > default
    this.locale = this.detectLocale(options.defaultLocale);

    // Load translation for current locale
    await this.loadLocale(this.locale);

    // Apply translations to DOM
    this.translatePage();
  }

  /**
   * Detect user's preferred locale
   * @param {string} defaultLocale - Default locale if detection fails
   * @returns {string} Detected locale code
   */
  detectLocale(defaultLocale = 'zh') {
    // 1. Check URL parameter: ?lang=en
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    if (urlLang && this.supportedLocales.includes(urlLang)) {
      return urlLang;
    }

    // 2. Check localStorage
    const savedLang = localStorage.getItem('preferred_language');
    if (savedLang && this.supportedLocales.includes(savedLang)) {
      return savedLang;
    }

    // 3. Check browser language
    const browserLang = navigator.language || navigator.userLanguage;
    const langCode = browserLang.split('-')[0].toLowerCase();

    // Map browser language codes to supported locales
    const langMap = {
      'en': 'en',
      'zh': 'zh',
      'ja': 'ja'
    };

    if (langMap[langCode] && this.supportedLocales.includes(langMap[langCode])) {
      return langMap[langCode];
    }

    // 4. Use default locale
    return defaultLocale;
  }

  /**
   * Load translation file for a specific locale
   * @param {string} locale - Locale code (e.g., 'en', 'zh', 'ja')
   */
  async loadLocale(locale) {
    if (!this.supportedLocales.includes(locale)) {
      console.warn(`[i18n] Unsupported locale: ${locale}, using fallback: ${this.fallbackLocale}`);
      locale = this.fallbackLocale;
    }

    try {
      const response = await fetch(`/locales/${locale}.json`);
      if (!response.ok) {
        throw new Error(`Failed to load ${locale}.json`);
      }
      this.translations[locale] = await response.json();
      console.log(`[i18n] Loaded locale: ${locale}`);
    } catch (error) {
      console.error(`[i18n] Error loading locale ${locale}:`, error);

      // Try loading fallback locale if current locale fails
      if (locale !== this.fallbackLocale) {
        console.log(`[i18n] Loading fallback locale: ${this.fallbackLocale}`);
        try {
          const fallbackResponse = await fetch(`/locales/${this.fallbackLocale}.json`);
          this.translations[this.fallbackLocale] = await fallbackResponse.json();
        } catch (fallbackError) {
          console.error(`[i18n] Failed to load fallback locale:`, fallbackError);
        }
      }
    }
  }

  /**
   * Get translation for a key
   * @param {string} key - Translation key (supports dot notation, e.g., 'common.ok')
   * @param {Object} params - Parameters for string interpolation
   * @param {number} params.count - Count for plural forms (optional)
   * @returns {string} Translated string
   */
  t(key, params = {}) {
    let translation = this.getNestedValue(this.translations[this.locale], key);

    // Fallback to fallback locale if translation not found
    if (translation === undefined && this.locale !== this.fallbackLocale) {
      translation = this.getNestedValue(this.translations[this.fallbackLocale], key);
    }

    // Return key if no translation found
    if (translation === undefined) {
      console.warn(`[i18n] Missing translation for key: ${key}`);
      return key;
    }

    // Handle plural forms
    if (typeof translation === 'object' && params.count !== undefined) {
      translation = this.getPluralForm(translation, params.count, this.locale);
    }

    // String interpolation: replace {{param}} with actual values
    if (typeof translation === 'string' && Object.keys(params).length > 0) {
      return translation.replace(/\{\{(\w+)\}\}/g, (match, param) => {
        return params[param] !== undefined ? params[param] : match;
      });
    }

    return translation;
  }

  /**
   * Get appropriate plural form based on count and locale
   * @param {Object} pluralObj - Object containing plural forms
   * @param {number} count - The count to determine plural form
   * @param {string} locale - Current locale
   * @returns {string} Appropriate plural form
   */
  getPluralForm(pluralObj, count, locale) {
    // English plural rules: one (1), other (0, 2+)
    // Chinese: other (all numbers, no plural distinction)
    // Japanese: other (all numbers, no plural distinction)

    const pluralRules = {
      'en': (n) => {
        if (n === 1) return 'one';
        return 'other';
      },
      'zh': () => 'other', // Chinese has no plural forms
      'ja': () => 'other'  // Japanese has no plural forms
    };

    const getForm = pluralRules[locale] || pluralRules['en'];
    const form = getForm(count);

    // Try to get the specific form, fallback to 'other'
    return pluralObj[form] || pluralObj['other'] || pluralObj['one'] || '';
  }

  /**
   * Get nested value from object using dot notation
   * @param {Object} obj - Object to traverse
   * @param {string} path - Dot notation path (e.g., 'common.ok')
   * @returns {*} Value at path
   */
  getNestedValue(obj, path) {
    if (!obj) return undefined;

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current[key] === undefined) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }

  /**
   * Translate all elements on the page with data-i18n attribute
   */
  translatePage() {
    // Translate elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const key = element.getAttribute('data-i18n');
      element.textContent = this.t(key);
    });

    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
      const key = element.getAttribute('data-i18n-placeholder');
      element.placeholder = this.t(key);
    });

    // Translate titles (tooltips)
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
      const key = element.getAttribute('data-i18n-title');
      element.title = this.t(key);
    });

    // Translate data-tooltip attributes (for custom tooltip implementations)
    document.querySelectorAll('[data-i18n-tooltip]').forEach(element => {
      const key = element.getAttribute('data-i18n-tooltip');
      element.setAttribute('data-tooltip', this.t(key));
    });

    // Translate HTML content (for elements that need HTML)
    document.querySelectorAll('[data-i18n-html]').forEach(element => {
      const key = element.getAttribute('data-i18n-html');
      element.innerHTML = this.t(key);
    });

    // Update HTML lang attribute
    document.documentElement.lang = this.getLanguageTag(this.locale);

    // Update SEO meta tags
    this.updateSEO();
  }

  /**
   * Update SEO-related meta tags and document title
   */
  updateSEO() {
    // Update document title
    const title = this.t('seo.title');
    if (title && title !== 'seo.title') {
      document.title = title;
    }

    // Update meta description
    const description = this.t('seo.description');
    if (description && description !== 'seo.description') {
      this.updateMetaTag('description', description);
    }

    // Update meta keywords
    const keywords = this.t('seo.keywords');
    if (keywords && keywords !== 'seo.keywords') {
      this.updateMetaTag('keywords', keywords);
    }

    // Update Open Graph tags
    const ogTitle = this.t('seo.ogTitle');
    if (ogTitle && ogTitle !== 'seo.ogTitle') {
      this.updateMetaTag('og:title', ogTitle, 'property');
    }

    const ogDescription = this.t('seo.ogDescription');
    if (ogDescription && ogDescription !== 'seo.ogDescription') {
      this.updateMetaTag('og:description', ogDescription, 'property');
    }

    // Update og:locale
    this.updateMetaTag('og:locale', this.getOgLocale(this.locale), 'property');

    // Update Twitter Card tags
    if (ogTitle && ogTitle !== 'seo.ogTitle') {
      this.updateMetaTag('twitter:title', ogTitle);
    }
    if (ogDescription && ogDescription !== 'seo.ogDescription') {
      this.updateMetaTag('twitter:description', ogDescription);
    }

    // Update canonical URL with lang parameter
    this.updateCanonicalUrl();

    // Update hreflang alternate links
    this.updateHreflangLinks();
  }

  /**
   * Update or create a meta tag
   * @param {string} name - Meta tag name or property
   * @param {string} content - Meta tag content
   * @param {string} attribute - Attribute type ('name' or 'property')
   */
  updateMetaTag(name, content, attribute = 'name') {
    let meta = document.querySelector(`meta[${attribute}="${name}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute(attribute, name);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
  }

  /**
   * Get Open Graph locale format
   * @param {string} locale - Locale code
   * @returns {string} OG locale (e.g., 'zh_CN', 'en_US', 'ja_JP')
   */
  getOgLocale(locale) {
    const ogLocales = {
      'en': 'en_US',
      'zh': 'zh_CN',
      'ja': 'ja_JP'
    };
    return ogLocales[locale] || 'en_US';
  }

  /**
   * Update canonical URL
   */
  updateCanonicalUrl() {
    const baseUrl = window.location.origin + window.location.pathname;
    const canonicalUrl = `${baseUrl}?lang=${this.locale}`;

    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', canonicalUrl);
  }

  /**
   * Update hreflang alternate links for SEO
   */
  updateHreflangLinks() {
    const baseUrl = window.location.origin + window.location.pathname;

    // Remove existing hreflang links
    document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(el => el.remove());

    // Add hreflang links for all supported locales
    this.supportedLocales.forEach(locale => {
      const link = document.createElement('link');
      link.setAttribute('rel', 'alternate');
      link.setAttribute('hreflang', this.getLanguageTag(locale));
      link.setAttribute('href', `${baseUrl}?lang=${locale}`);
      document.head.appendChild(link);
    });

    // Add x-default hreflang (points to default locale)
    const defaultLink = document.createElement('link');
    defaultLink.setAttribute('rel', 'alternate');
    defaultLink.setAttribute('hreflang', 'x-default');
    defaultLink.setAttribute('href', `${baseUrl}?lang=${this.fallbackLocale}`);
    document.head.appendChild(defaultLink);
  }

  /**
   * Get full language tag for HTML lang attribute
   * @param {string} locale - Locale code
   * @returns {string} Language tag (e.g., 'en-US', 'zh-CN', 'ja-JP')
   */
  getLanguageTag(locale) {
    const tags = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP'
    };
    return tags[locale] || locale;
  }

  /**
   * Change locale and retranslate page
   * @param {string} newLocale - New locale code
   */
  async changeLocale(newLocale) {
    if (!this.supportedLocales.includes(newLocale)) {
      console.error(`[i18n] Unsupported locale: ${newLocale}`);
      return;
    }

    if (newLocale === this.locale) {
      return; // No change needed
    }

    // Load new locale if not already loaded
    if (!this.translations[newLocale]) {
      await this.loadLocale(newLocale);
    }

    this.locale = newLocale;

    // Save to localStorage
    localStorage.setItem('preferred_language', newLocale);

    // Update URL parameter (without reload)
    const url = new URL(window.location);
    url.searchParams.set('lang', newLocale);
    window.history.replaceState({}, '', url);

    // Retranslate page
    this.translatePage();

    // Emit custom event for other components to react
    window.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale: newLocale } }));

    console.log(`[i18n] Locale changed to: ${newLocale}`);
  }

  /**
   * Get current locale
   * @returns {string} Current locale code
   */
  getCurrentLocale() {
    return this.locale;
  }

  /**
   * Get locale display name
   * @param {string} locale - Locale code
   * @returns {string} Display name
   */
  getLocaleDisplayName(locale) {
    const names = {
      'en': 'English',
      'zh': '简体中文',
      'ja': '日本語'
    };
    return names[locale] || locale;
  }

  /**
   * Get all supported locales with display names
   * @returns {Array<{code: string, name: string}>}
   */
  getSupportedLocales() {
    return this.supportedLocales.map(code => ({
      code,
      name: this.getLocaleDisplayName(code)
    }));
  }
}

// Create and export singleton instance
export const i18n = new I18n();

// Export as default for convenience
export default i18n;
