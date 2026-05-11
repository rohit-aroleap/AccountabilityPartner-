import './firebase-init.js';
import './version.js';
import { initSettings, onSettingsSaved } from './settings.js';
import { initCustomers, refresh } from './customers.js';

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initCustomers();
  onSettingsSaved(() => refresh());
});
