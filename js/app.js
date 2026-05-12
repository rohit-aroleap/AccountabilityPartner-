import './firebase-init.js';
import './version.js';
import { initSettings, onSettingsSaved } from './settings.js';
import { initCustomers, refresh } from './customers.js';
import { initChat } from './chat.js';
import { initCustomerSettings } from './customer-settings.js';
import { initAutomationFeed } from './automation-feed.js';

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initCustomerSettings();
  initChat();
  initCustomers();
  initAutomationFeed();
  onSettingsSaved(() => refresh());
});
