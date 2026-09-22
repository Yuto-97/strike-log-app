// POST /api/account/claim-device
// Headers: Authorization: Bearer <Firebase ID token>
// Body: { deviceId }
// Called right after a successful sign-in. Marks `deviceId` as this
// account's one active device — any device that was previously active for
// this account fails its next device check and gets signed out.
//
// The account is identified ONLY from the verified ID token, never from the
// request body, so nobody can claim someone else's account.
//
// Reuses the accessRequests collection, keyed by the Firebase Auth uid, so
// the existing admin approval panel keeps working unchanged.
import { db, adminAuth } from "../_firebaseAdmin.js";
import { generateUniqueId } from "../_idGenerator.js";
import { verifyCaller } from "../_accountAuth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const caller = await verifyCaller(req, adminAuth);
  if (!caller) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const { deviceId } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") {
    res.status(400).json({ error: "deviceId is required" });
    return;
  }

  try {
    const ref = db.collection("accessRequests").doc(caller.uid);
    const existing = await ref.get();
    const prev = existing.exists ? existing.data() : {};
    const now = new Date().toISOString();

    const requestNumber = prev.requestNumber || (await generateUniqueId());
    const status = prev.status || "pending";

    await ref.set(
      {
        name: caller.email || prev.name || null,
        email: caller.email || prev.email || null,
        isAccount: true,
        activeDeviceId: deviceId,
        status,
        requestNumber,
        requestedAt: prev.requestedAt || now,
        updatedAt: now,
      },
      { merge: true }
    );

    res.status(200).json({ status, requestNumber, activeDeviceId: deviceId });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
