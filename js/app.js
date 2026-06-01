import './firebase-init.js';   // unchanged, just kept first so auth is initialised
import { initAuthGate, onAdminReady } from './auth.js';
import './version.js';
import { initSettings, onSettingsSaved } from './settings.js';
import { initCustomers, refresh } from './customers.js';
import { initChat } from './chat.js';
import { initCustomerSettings, onCustomerRemoved } from './customer-settings.js';
import { initAutomationFeed } from './automation-feed.js';
import { initTuneAi } from './tune-ai.js';
import { initAddCustomer, onCustomerAdded } from './add-customer.js';
import { subscribeGlobalConfig } from './global-config.js';
import { initWorkoutBanner } from './workout-banner.js';

document.addEventListener('DOMContentLoaded', () => {
  // Auth gate FIRST — overlay shows immediately if not signed in.
  initAuthGate();

  // App init waits until an authorised admin is signed in. If they're
  // already signed in (browserLocalPersistence resumes the session),
  // this fires synchronously. Otherwise it fires once they sign in.
  onAdminReady(() => {
    initSettings();
    initCustomerSettings();
    initTuneAi();
    initAddCustomer();
    initChat();
    initWorkoutBanner();
    initCustomers();
    initAutomationFeed();
    onSettingsSaved(() => refresh());
    onCustomerAdded(() => refresh());
    onCustomerRemoved(() => refresh());
    subscribeGlobalConfig(() => { /* keep cache warm */ });
  });
});
