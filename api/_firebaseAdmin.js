// Shared Firestore connection for backend API routes. Uses a Firebase
// service account (server-side only — never exposed to the browser) so
// requests, approvals, and feedback can be read/written from any device
// while staying centrally controlled by the admin.
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

export const db = admin.firestore();
