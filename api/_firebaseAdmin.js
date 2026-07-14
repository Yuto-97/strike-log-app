// Shared Firestore connection for backend API routes. Uses a Firebase
// service account (server-side only — never exposed to the browser) so
// requests, approvals, and feedback can be read/written from any device
// while staying centrally controlled by the admin.
//
// Preferred setup: FIREBASE_SERVICE_ACCOUNT_BASE64 — the entire downloaded
// service-account JSON file, base64-encoded into a single env var. This
// avoids the classic problem where FIREBASE_PRIVATE_KEY's escaped newlines
// get mangled when pasted into a dashboard text field.
//
// Fallback: the three separate FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY vars, for anyone who already set those up.
import admin from "firebase-admin";

function loadCredential() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  };
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadCredential()),
  });
}

export const db = admin.firestore();
