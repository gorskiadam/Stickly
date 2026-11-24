// firebase-config.js — which Firebase project Stickly syncs through.
// These values are meant to be public (every Firebase web app ships them);
// what keeps the notes private are the Firestore rules: each account can
// only read and write its own users/{uid}/… documents.

export const firebaseConfig = {
  apiKey: 'AIzaSyCSq7AKAhbD3oHPO1xgqlEbwgJNuoaSnNc',
  authDomain: 'stickly-fb4f1.firebaseapp.com',
  projectId: 'stickly-fb4f1',
  storageBucket: 'stickly-fb4f1.firebasestorage.app',
  messagingSenderId: '786571117453',
  appId: '1:786571117453:web:38ffa6f40cf21a86c2f3c4',
};
