import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

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
export const auth = getAuth(firebaseApp);

// Persist sign-in across page reloads — trainer doesn't have to log in
// every visit. Same convention as the other 6 dashboards in the suite.
await setPersistence(auth, browserLocalPersistence);

// Re-export the auth API surface so other modules don't have to import
// from firebase.js URLs themselves.
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };
