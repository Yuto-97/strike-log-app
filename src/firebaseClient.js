// Client-side Firebase init, used only for Authentication (email/password).
// All app data (games, access requests, etc.) still goes through our own
// /api/* routes backed by firebase-admin — this file does NOT touch
// Firestore directly, to avoid needing separate security rules.
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
