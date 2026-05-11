import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC5mZAG98VAeDpp1IssYYQ2kcKeClyqIGc',
  authDomain: 'motherofdashboard.firebaseapp.com',
  databaseURL: 'https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'motherofdashboard',
  storageBucket: 'motherofdashboard.firebasestorage.app',
  messagingSenderId: '1014194001329',
  appId: '1:1014194001329:web:d9e59cf8c76ed33cd2d990',
};

export const ROOT_PATH = 'accountabilityPartner/v1';
export const firebaseApp = initializeApp(firebaseConfig);
export const db = getDatabase(firebaseApp);
