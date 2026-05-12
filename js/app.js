import './firebase-init.js';
import './version.js';
import { initSettings, onSettingsSaved } from './settings.js';
import { initCustomers, refresh } from './customers.js';
import { initChat } from './chat.js';
import { initCustomerSettings } from './customer-settings.js';
import { initAutomationFeed } from './automation-feed.js';
import { initTuneAi } from './tune-ai.js';
import { initAddCustomer, onCustomerAdded } from './add-customer.js';
import { subscribeGlobalConfig } from './global-config.js';

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initCustomerSettings();
  initTuneAi();
  initAddCustomer();
  initChat();
  initCustomers();
  initAutomationFeed();
  onSettingsSaved(() => refresh());
  onCustomerAdded(() => refresh());
  subscribeGlobalConfig(() => { /* keep cache warm */ });
});
