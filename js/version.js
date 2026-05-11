export const APP_VERSION = 'v1.003';

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-version]').forEach(el => {
    el.textContent = APP_VERSION;
  });
});
