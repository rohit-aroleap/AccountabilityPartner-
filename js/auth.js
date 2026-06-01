import {
  auth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from './firebase-init.js';

// Hardcoded allow-list. Keep small — this is a single-admin tool.
const ADMIN_EMAILS = new Set([
  'rohit@aroleap.com',
]);
function isAdminEmail(email) {
  return !!(email && ADMIN_EMAILS.has(String(email).trim().toLowerCase()));
}

let _adminReady = false;
const _adminReadyCallbacks = [];
let _currentUser = null;

/**
 * Register a callback to run once an authorised admin is signed in.
 * If admin is already signed in, fires immediately. Otherwise fires
 * once the sign-in succeeds.
 */
export function onAdminReady(cb) {
  if (_adminReady) {
    cb(_currentUser);
  } else {
    _adminReadyCallbacks.push(cb);
  }
}

export function getCurrentUser() {
  return _adminReady ? _currentUser : null;
}

// Sign-in overlay element references (filled in initAuthGate).
let overlayEl = null;
let formEl = null;
let emailEl = null;
let pwdEl = null;
let errEl = null;
let signInBtn = null;
let signOutBtn = null;

export function initAuthGate() {
  overlayEl = document.getElementById('auth-overlay');
  formEl = document.getElementById('auth-form');
  emailEl = document.getElementById('auth-email');
  pwdEl = document.getElementById('auth-password');
  errEl = document.getElementById('auth-error');
  signInBtn = document.getElementById('auth-signin-btn');
  signOutBtn = document.getElementById('auth-signout-btn');

  if (!overlayEl) {
    console.error('[auth] #auth-overlay element missing in index.html');
    return;
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleSignIn();
  });
  if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

  onAuthStateChanged(auth, (user) => {
    _currentUser = user;
    if (user && isAdminEmail(user.email)) {
      hideOverlay();
      if (!_adminReady) {
        _adminReady = true;
        const cbs = _adminReadyCallbacks.splice(0);
        cbs.forEach((cb) => { try { cb(user); } catch (e) { console.error(e); } });
      }
      // Show signed-in chrome if present (e.g., a small "Signed in as X · Sign out" row)
      const whoEl = document.getElementById('auth-who');
      if (whoEl) whoEl.textContent = user.email || '';
      const whoRow = document.getElementById('auth-who-row');
      if (whoRow) whoRow.style.display = '';
    } else {
      _adminReady = false;
      const whoRow = document.getElementById('auth-who-row');
      if (whoRow) whoRow.style.display = 'none';
      // If a non-admin email signs in, show overlay with an error.
      if (user && !isAdminEmail(user.email)) {
        showOverlay(
          `Signed in as ${user.email}, but that email isn't authorised. ` +
          `Sign out and try a different one.`,
          /* allowSignOutLink */ true,
        );
      } else {
        showOverlay('');
      }
    }
  });
}

async function handleSignIn() {
  const email = (emailEl.value || '').trim();
  const pwd = pwdEl.value || '';
  if (!email || !pwd) {
    showError('Email and password required');
    return;
  }
  if (!isAdminEmail(email)) {
    showError('Not an authorised admin email');
    return;
  }
  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in…';
  try {
    await signInWithEmailAndPassword(auth, email, pwd);
    // onAuthStateChanged hides the overlay on success.
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') showError('Wrong password');
    else if (code === 'auth/user-not-found') showError('No such user — create one in Firebase Console first');
    else if (code === 'auth/too-many-requests') showError('Too many attempts — wait a moment');
    else showError('Sign in failed: ' + (e.message || code));
    console.error(e);
  } finally {
    signInBtn.disabled = false;
    signInBtn.textContent = 'Sign in';
  }
}

async function handleSignOut() {
  try {
    await signOut(auth);
  } catch (e) { console.warn('[auth] signOut failed:', e); }
}

function showOverlay(message, allowSignOutLink = false) {
  overlayEl.hidden = false;
  document.body.classList.add('auth-locked');
  if (message) showError(message);
  else if (errEl) errEl.textContent = '';

  // If a non-admin email is signed in, show a sign-out link inside the overlay.
  const linkEl = document.getElementById('auth-signout-link');
  if (linkEl) {
    if (allowSignOutLink) {
      linkEl.style.display = '';
      linkEl.onclick = (ev) => { ev.preventDefault(); handleSignOut(); };
    } else {
      linkEl.style.display = 'none';
    }
  }
}

function hideOverlay() {
  overlayEl.hidden = true;
  document.body.classList.remove('auth-locked');
  if (errEl) errEl.textContent = '';
}

function showError(msg) {
  if (errEl) errEl.textContent = msg;
}
