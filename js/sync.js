// sync.js — the same notes on every device, through Firebase.
//
// Sign in with Google, or with an email and password (Settings → Sync), and
// this device's notes are put
// together with the ones in the cloud. From then on:
//   · every change is saved here first, as always, so Stickly stays instant
//     and works offline, and goes up a moment later;
//   · changes made on another device come down live and are merged in
//     note by note (syncmerge.js), so nothing typed anywhere is lost;
//   · offline, changes wait and go up when the connection is back.
// Each account's notes live in Firestore at users/{uid}/stickly/state, and
// the database's rules let only that account read or write them.
// Firebase is only loaded once sync has been turned on, so it costs nothing
// for anyone who doesn't use it.

import { getState, subscribe, syncData, applySynced } from './store.js';
import { merge, same, EMPTY } from './syncmerge.js';
import { firebaseConfig } from './firebase-config.js';
import { showToast } from './feedback.js';
import { t } from './strings.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const ON_KEY = 'stickly:sync'; // '1' once signed in on this device
const BASE_KEY = 'stickly:sync-base'; // the copy this device and the cloud last agreed on
const PUSH_DELAY_MS = 700;
const RETRY_MS = 20_000;

const statusLine = document.getElementById('sync-status');
const signInButton = document.getElementById('sync-signin');
const signOutButton = document.getElementById('sync-signout');
const emailOpen = document.getElementById('sync-email-open');
const emailForm = document.getElementById('sync-email');
const emailInput = document.getElementById('sync-email-address');
const passwordInput = document.getElementById('sync-email-password');
const emailNote = document.getElementById('sync-email-note');
const emailSubmit = document.getElementById('sync-email-submit');
const emailMode = document.getElementById('sync-email-mode');
const emailReset = document.getElementById('sync-email-reset');

let fb = null; // the loaded Firebase pieces
let user = null;
let ref = null; // this account's document
let stopListening = null;
let base = null;
let applying = false; // a merged copy is being put in: not a change of ours
let dirty = false; // something here hasn't gone up yet
let pushTimer = 0;
let pushing = false;
let status = 'off'; // off | connecting | syncing | synced | offline | error
let lastSynced = 0;
let lastError = null;
let creating = false; // the email form makes a new account instead of signing in
let emailBusy = false;

export function initSync() {
  signInButton.addEventListener('click', signIn);
  signOutButton.addEventListener('click', signOut);
  emailOpen.addEventListener('click', openEmail);
  emailForm.addEventListener('submit', (event) => { event.preventDefault(); emailSignIn(); });
  emailMode.addEventListener('click', () => { creating = !creating; note(''); renderEmail(); });
  emailReset.addEventListener('click', resetPassword);
  // keys typed here are for the form, not Stickly's shortcuts
  emailForm.addEventListener('keydown', (event) => { if (event.key !== 'Escape') event.stopPropagation(); });
  subscribe(onLocalChange);
  window.addEventListener('online', () => { if (user) push(); });
  window.addEventListener('offline', () => { if (user) setStatus('offline'); });
  setInterval(() => { if (user && dirty && navigator.onLine) push(); }, RETRY_MS);
  // "Synced · 2 min ago" keeps itself current
  setInterval(() => { if (status === 'synced') render(); }, 30_000);
  render();
  if (localStorage.getItem(ON_KEY) === '1') start().catch(fail);
}

// ---------- Signing in and out ----------

async function load() {
  if (fb) return fb;
  const [app, auth, store] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const firebase = app.initializeApp(firebaseConfig);
  fb = { auth, store, authApp: auth.getAuth(firebase), db: store.getFirestore(firebase) };
  return fb;
}

/** Load Firebase and follow whoever is signed in. */
async function start() {
  setStatus('connecting');
  await load();
  // coming back from a sign-in by redirect (used when a popup isn't possible)
  fb.auth.getRedirectResult(fb.authApp).catch(fail);
  fb.auth.onAuthStateChanged(fb.authApp, onUser);
}

async function signIn() {
  try {
    if (!fb) await start();
    const provider = new fb.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await fb.auth.signInWithPopup(fb.authApp, provider);
    } catch (err) {
      // popups blocked, or an installed app on a phone: go by redirect instead
      if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(err.code || '')) {
        await fb.auth.signInWithRedirect(fb.authApp, provider);
      } else if (!/popup-closed|cancelled-popup/.test(err.code || '')) {
        throw err;
      } else {
        render();
      }
    }
  } catch (err) {
    fail(err);
  }
}

// ---------- Email and password ----------

function openEmail() {
  emailForm.hidden = false;
  emailOpen.hidden = true;
  renderEmail();
  emailInput.focus();
}

async function emailSignIn() {
  if (emailBusy) return;
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note(t('syncBadEmail'), true); emailInput.focus(); return; }
  if (password.length < 6) { note(t('syncShortPassword'), true); passwordInput.focus(); return; }
  setEmailBusy(true);
  note('');
  try {
    if (!fb) await start();
    if (creating) await fb.auth.createUserWithEmailAndPassword(fb.authApp, email, password);
    else await fb.auth.signInWithEmailAndPassword(fb.authApp, email, password);
    passwordInput.value = '';
    emailForm.hidden = true;
    creating = false;
  } catch (err) {
    console.warn('Stickly sign-in:', err);
    note(emailReason(err), true);
    if (status === 'connecting') setStatus('off');
  } finally {
    setEmailBusy(false);
  }
}

async function resetPassword() {
  const email = emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note(t('syncResetNeedsEmail'), true); emailInput.focus(); return; }
  setEmailBusy(true);
  try {
    if (!fb) await start();
    fb.authApp.languageCode = document.documentElement.lang || 'en'; // the email comes in Stickly's language
    await fb.auth.sendPasswordResetEmail(fb.authApp, email);
    note(t('syncResetSent', { email }));
  } catch (err) {
    console.warn('Stickly password reset:', err);
    // don't reveal whether an account exists: a missing one reads like a sent link
    if (/user-not-found/.test(err.code || '')) note(t('syncResetSent', { email }));
    else note(emailReason(err), true);
  } finally {
    setEmailBusy(false);
    if (status === 'connecting') setStatus('off');
  }
}

function emailReason(err) {
  const code = err?.code || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(code)) return t('syncWrongPassword');
  if (code.includes('email-already-in-use')) return t('syncEmailTaken');
  if (code.includes('weak-password')) return t('syncShortPassword');
  if (code.includes('invalid-email')) return t('syncBadEmail');
  if (code.includes('too-many-requests')) return t('syncTooMany');
  if (code.includes('operation-not-allowed')) return t('syncWhyEmailProvider');
  return reason(err) || t('syncError', { reason: '' });
}

function note(text, isError = false) {
  emailNote.textContent = text;
  emailNote.hidden = !text;
  emailNote.dataset.error = isError ? 'true' : 'false';
}

function setEmailBusy(busy) {
  emailBusy = busy;
  emailSubmit.disabled = busy;
  emailReset.disabled = busy;
  emailForm.setAttribute('aria-busy', String(busy));
}

function renderEmail() {
  emailSubmit.textContent = t(creating ? 'syncEmailCreate' : 'syncEmailSignIn');
  emailMode.textContent = t(creating ? 'syncEmailToSignIn' : 'syncEmailToCreate');
  emailReset.hidden = creating;
  passwordInput.autocomplete = creating ? 'new-password' : 'current-password';
}

async function signOut() {
  if (!fb) return;
  await fb.auth.signOut(fb.authApp).catch(() => {});
  localStorage.removeItem(ON_KEY);
  localStorage.removeItem(BASE_KEY);
  showToast(t('syncSignedOut'), null, '', 'info');
}

function onUser(next) {
  stopListening?.();
  stopListening = null;
  user = next;
  if (!user) {
    ref = null;
    base = null;
    setStatus('off');
    return;
  }
  localStorage.setItem(ON_KEY, '1');
  ref = fb.store.doc(fb.db, 'users', user.uid, 'stickly', 'state');
  base = readBase(user.uid);
  setStatus('syncing');
  stopListening = fb.store.onSnapshot(ref, { includeMetadataChanges: false }, onRemote, fail);
}

// ---------- Down: a change from the cloud ----------

function onRemote(snap) {
  if (snap.metadata.hasPendingWrites) return;
  if (!snap.exists()) {
    // nothing in the cloud yet: this device's notes are the first
    dirty = true;
    push();
    return;
  }
  const remote = parse(snap.data().data);
  if (!remote) return;
  const firstTime = !base;
  const local = syncData();
  const merged = merge(base, local, remote);
  saveBase(remote);
  if (!same(merged, local)) adopt(merged);
  if (!same(syncData(), remote)) {
    dirty = true;
    schedulePush(0);
  } else {
    dirty = false;
    synced();
  }
  if (firstTime) showToast(t('syncStarted'), null, '', 'info');
}

/** Put a merged copy into the store, without that counting as a change of ours. */
function adopt(data) {
  applying = true;
  try { applySynced(data); } finally { applying = false; }
}

// ---------- Up: a change made here ----------

function onLocalChange() {
  render(); // the language may have changed
  if (applying || !user) return;
  if (same(syncData(), base)) return; // only settings that stay on this device changed
  dirty = true;
  schedulePush(PUSH_DELAY_MS);
}

function schedulePush(delay) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, delay);
}

/**
 * Send this device's notes up. In one transaction: read what's in the cloud,
 * merge this device's changes into it, write the result. If another device
 * wrote in between, Firestore runs it again on the newer copy.
 */
async function push() {
  if (!user || !ref || pushing) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  pushing = true;
  setStatus('syncing');
  try {
    const local = syncData();
    const merged = await fb.store.runTransaction(fb.db, async (tx) => {
      const snap = await tx.get(ref);
      const remote = snap.exists() ? parse(snap.data().data) : null;
      const result = remote ? merge(base, local, remote) : local;
      tx.set(ref, { data: JSON.stringify(result), updatedAt: fb.store.serverTimestamp(), app: 'stickly', version: 1 });
      return result;
    });
    saveBase(merged);
    // something changed here while it was going up: that goes next
    const now = syncData();
    if (!same(now, local)) {
      schedulePush(PUSH_DELAY_MS);
    } else {
      if (!same(merged, now)) adopt(merged);
      dirty = false;
      synced();
    }
  } catch (err) {
    if (!navigator.onLine || err.code === 'unavailable') setStatus('offline');
    else fail(err);
  } finally {
    pushing = false;
  }
}

// ---------- The agreed copy ----------

function readBase(uid) {
  try {
    const saved = JSON.parse(localStorage.getItem(BASE_KEY));
    return saved && saved.uid === uid ? saved.data : null;
  } catch {
    return null;
  }
}

function saveBase(data) {
  base = data;
  try { localStorage.setItem(BASE_KEY, JSON.stringify({ uid: user.uid, data })); } catch { /* storage full: it'll merge as a first time */ }
}

function parse(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? { ...EMPTY, ...data } : null;
  } catch {
    return null;
  }
}

// ---------- What Settings shows ----------

function synced() {
  lastSynced = Date.now();
  setStatus('synced');
}

function fail(err) {
  console.warn('Stickly sync:', err);
  setStatus('error', err);
}

function setStatus(next, err = null) {
  status = next;
  lastError = err;
  render();
}

function render() {
  const err = lastError;
  const on = Boolean(user);
  signInButton.hidden = on || status === 'connecting';
  signOutButton.hidden = !on;
  emailOpen.hidden = on || !emailForm.hidden;
  if (on) emailForm.hidden = true;
  renderEmail();
  const who = user?.email || user?.displayName || '';
  let text;
  if (status === 'error') text = t('syncError', { reason: reason(err) });
  else if (!on) text = status === 'connecting' ? t('syncConnecting') : t('syncIntro');
  else if (status === 'offline') text = t('syncOffline');
  else if (status === 'syncing' || status === 'connecting') text = t('syncSyncing');
  else text = t('syncSynced', { who, when: ago(lastSynced) });
  statusLine.textContent = text;
  statusLine.dataset.state = status;
  if (status === 'error' && !on) signInButton.hidden = false;
}

function reason(err) {
  const code = err?.code || '';
  if (code.includes('unauthorized-domain')) return t('syncWhyDomain');
  if (code.includes('permission-denied')) return t('syncWhyRules');
  if (code.includes('operation-not-allowed')) return t('syncWhyProvider');
  if (code.includes('network') || code === 'unavailable' || err instanceof TypeError) return t('syncWhyNetwork');
  return err?.message ? err.message.replace(/^Firebase:\s*/, '').slice(0, 120) : '';
}

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  return minutes < 1 ? t('syncNow') : t('syncMinutesAgo', { n: minutes });
}

/** For tests and the console: what sync is doing. */
export function syncStatus() {
  return { status, user: user?.uid || null, dirty, base: Boolean(base), notes: getState().notes.length };
}
