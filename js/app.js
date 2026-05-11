import './firebase-init.js';
import './version.js';
import { initSettings, onSettingsSaved } from './settings.js';
import { initCustomers, refresh } from './customers.js';
import { initChat } from './chat.js';

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initChat();
  initCustomers();
  onSettingsSaved(() => refresh());
});
