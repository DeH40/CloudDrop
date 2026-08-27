/**
 * CloudDrop - 分级日志
 * console.log 全部走 debugLog，生产环境默认静默。
 * 开启方式：URL 加 ?debug=1，或 localStorage.setItem('clouddrop_debug', '1')
 * console.warn/console.error 保留（错误信息始终输出）。
 */

const DEBUG_ENABLED = (() => {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) {
      return true;
    }
    return localStorage.getItem('clouddrop_debug') === '1';
  } catch (e) {
    return false;
  }
})();

export function debugLog(...args) {
  if (DEBUG_ENABLED) console.log(...args);
}
