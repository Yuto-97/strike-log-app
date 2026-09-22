// Client-side Firebase init, used only for Authentication (email/password).
// All app data goes through our own /api/* routes backed by firebase-admin —
// this file does NOT touch Firestore directly.
//
// Fails safe: if the Firebase keys are missing or wrong (e.g. an environment
// variable not set on Vercel), `auth` is null and the app keeps working
// without account features, instead of crashing to a blank screen for
// every user.
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

let authInstance = null;
try {
  if (firebaseConfig.apiKey) {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    authInstance = getAuth(app);
  }
} catch (e) {
  console.warn("Firebase Auth unavailable; account features disabled.", e);
}

export const auth = authInstance;
