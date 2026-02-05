
import { i18n } from './i18n.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './config.js';

class StaticPage {
  constructor() {
    this.init();
  }

  async init() {
    // Initialize Theme first to prevent flash
    this.initTheme();

    // Initialize i18n
    await i18n.init({ defaultLocale: 'zh' });
    
    // Setup language switcher
    this.setupLanguageSwitcher();
    
    // Setup theme toggle
    this.setupThemeToggle();
    
    // Listen for locale changes to update UI
    window.addEventListener('localeChanged', () => {
      this.updateLanguageDisplay();
    });
    
    // Initial display update
    this.updateLanguageDisplay();
    
    // Remove "hidden" class from body or main content
    document.body.classList.add('loaded');
  }

  // ==========================================
  // Theme Management
  // ==========================================
  initTheme() {
    this.themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    // Load settings from localStorage
    const savedFunc = () => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
            return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
        } catch (e) {
            return { ...DEFAULT_SETTINGS };
        }
    };
    this.settings = savedFunc();
    
    // Apply initial theme
    this.applyTheme(this.settings.theme || 'system');

    // Listener for system theme changes
    if (this.themeMediaQuery && this.themeMediaQuery.addEventListener) {
      this.themeMediaQuery.addEventListener('change', (e) => {
        if (this.settings.theme === 'system') {
          this.applyTheme('system');
        }
      });
    }
  }

  applyTheme(theme) {
    let resolvedTheme = theme;
    if (theme === 'system') {
      resolvedTheme = (this.themeMediaQuery && this.themeMediaQuery.matches) ? 'dark' : 'light';
    }
    
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;
    
    // Update theme toggle icon if it exists
    this.updateThemeIcon(resolvedTheme);
  }

  toggleTheme() {
    const currentTheme = this.settings.theme;
    let newTheme;
    
    // Simple toggle logic: 
    // If system -> determine current resolved (light/dark) -> switch to opposite
    // If light -> dark
    // If dark -> light
    
    if (currentTheme === 'system') {
        const isDark = this.themeMediaQuery && this.themeMediaQuery.matches;
        newTheme = isDark ? 'light' : 'dark';
    } else {
        newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    }
    
    this.settings.theme = newTheme;
    this.saveSettings();
    this.applyTheme(newTheme);
  }

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  }

  setupThemeToggle() {
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        this.toggleTheme();
      });
    }
  }

  updateThemeIcon(theme) {
    const themeBtn = document.getElementById('themeBtn');
    if (!themeBtn) return;
    
    // Update icon based on resolved theme
    const isDark = theme === 'dark';
    themeBtn.innerHTML = isDark ? 
      // Moon icon for dark mode (showing current state is dark)
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>` :
      // Sun icon for light mode
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
      
     themeBtn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }

  // ==========================================
  // Language Management
  // ==========================================
  setupLanguageSwitcher() {
    const languageBtn = document.getElementById('languageBtn');
    const languageMenu = document.getElementById('languageMenu');
    
    if (!languageBtn || !languageMenu) return;

    // Toggle menu
    languageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      languageMenu.classList.toggle('show');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!languageBtn.contains(e.target) && !languageMenu.contains(e.target)) {
        languageMenu.classList.remove('show');
      }
    });

    // Language menu item clicks
    languageMenu.querySelectorAll('.language-menu-item').forEach(item => {
      item.addEventListener('click', async () => {
        const lang = item.getAttribute('data-lang');
        if (lang && lang !== i18n.getCurrentLocale()) {
          await i18n.changeLocale(lang);
        }
        languageMenu.classList.remove('show');
      });
    });
  }

  updateLanguageDisplay() {
    // Current Language Display
    const languageCodeEl = document.getElementById('currentLanguageCode');
    const languageFlagEl = document.getElementById('currentLanguageFlag');
    
    // Menu items
    const languageMenu = document.getElementById('languageMenu');
    const currentLocale = i18n.getCurrentLocale();

    // Flag SVG definitions (Unified with app.js)
    const flagSvgContent = {
       zh: `<rect width="36" height="24" fill="#DE2910"/>
           <polygon points="6,4 7.2,7.7 4,5.5 8,5.5 4.8,7.7" fill="#FFDE00"/>
           <polygon points="12,2 12.4,3.2 11.2,2.4 12.8,2.4 11.6,3.2" fill="#FFDE00"/>
           <polygon points="14,4 14.4,5.2 13.2,4.4 14.8,4.4 13.6,5.2" fill="#FFDE00"/>
           <polygon points="14,7 14.4,8.2 13.2,7.4 14.8,7.4 13.6,8.2" fill="#FFDE00"/>
           <polygon points="12,9 12.4,10.2 11.2,9.4 12.8,9.4 11.6,10.2" fill="#FFDE00"/>`,
      'zh-HK': `<rect width="36" height="24" fill="#DE2110"/>
           <g transform="translate(18,10) scale(0.75)">
             <g fill="white">
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(0)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(72)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(144)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(216)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(288)"/>
             </g>
             <g fill="#DE2110">
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(0)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(72)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(144)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(216)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(288)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(36)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(108)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(180)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(252)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(324)"/>
             </g>
           </g>`,
      en: `<rect width="36" height="24" fill="#B22234"/>
           <rect y="1.85" width="36" height="1.85" fill="white"/>
           <rect y="5.54" width="36" height="1.85" fill="white"/>
           <rect y="9.23" width="36" height="1.85" fill="white"/>
           <rect y="12.92" width="36" height="1.85" fill="white"/>
           <rect y="16.62" width="36" height="1.85" fill="white"/>
           <rect y="20.31" width="36" height="1.85" fill="white"/>
           <rect width="14.4" height="13" fill="#3C3B6E"/>`,
      ja: `<rect width="36" height="24" fill="white"/>
           <circle cx="18" cy="12" r="7" fill="#BC002D"/>`,
      ko: `<rect width="36" height="24" fill="white"/>
           <g transform="translate(18,12)">
             <circle cx="0" cy="0" r="6" fill="#C60C30"/>
             <path d="M0,-6 A6,6 0 0,1 0,6 A3,3 0 0,1 0,0 A3,3 0 0,0 0,-6" fill="#003478"/>
             <circle cx="0" cy="-3" r="3" fill="#C60C30"/>
             <circle cx="0" cy="3" r="3" fill="#003478"/>
           </g>
           <g stroke="#000" stroke-width="1.2">
             <g transform="translate(5.5,5) rotate(-15)">
               <line x1="-3.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(30.5,19) rotate(-15)">
               <line x1="-3.5" y1="-2" x2="-0.5" y2="-2"/><line x1="0.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="-0.5" y2="0"/><line x1="0.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="-0.5" y2="2"/><line x1="0.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(30.5,5) rotate(15)">
               <line x1="-3.5" y1="-2" x2="-0.5" y2="-2"/><line x1="0.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="-0.5" y2="2"/><line x1="0.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(5.5,19) rotate(15)">
               <line x1="-3.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="-0.5" y2="0"/><line x1="0.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="3.5" y2="2"/>
             </g>
           </g>`,
      es: `<rect width="36" height="6" fill="#AA151B"/>
           <rect y="6" width="36" height="12" fill="#F1BF00"/>
           <rect y="18" width="36" height="6" fill="#AA151B"/>`,
      fr: `<rect width="12" height="24" fill="#002395"/>
           <rect x="12" width="12" height="24" fill="white"/>
           <rect x="24" width="12" height="24" fill="#ED2939"/>`,
      de: `<rect width="36" height="8" fill="#000"/>
           <rect y="8" width="36" height="8" fill="#DD0000"/>
           <rect y="16" width="36" height="8" fill="#FFCE00"/>`,
      ar: `<rect width="36" height="8" fill="#006C35"/>
           <rect y="8" width="36" height="8" fill="white"/>
           <rect y="16" width="36" height="8" fill="#000"/>`
    };

    if (languageCodeEl) {
      languageCodeEl.textContent = currentLocale.toUpperCase();
    }

    if (languageFlagEl && flagSvgContent[currentLocale]) {
      languageFlagEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24">${flagSvgContent[currentLocale]}</svg>`;
    }

    if (languageMenu) {
      // Logic for button-style items (main page style)
      languageMenu.querySelectorAll('.language-menu-item').forEach(item => {
        const lang = item.getAttribute('data-lang');
        item.classList.toggle('active', lang === currentLocale);
      });
    }
  }
}

// Instantiate
new StaticPage();
