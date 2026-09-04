// POST /api/account/claim-device
// Body: { uid, deviceId, email }
// Called right after a successful Firebase Auth sign-in/sign-up. Marks
// `deviceId` as this account's one active device — any device that was
// previously active for this account will fail its next device-check poll
// and get signed out automatically (see /api/account/device-check).
//
// Reuses the existing accessRequests collection/admin-approval flow, just
// keyed by the Firebase Auth uid instead of a raw device id, so the same
// admin panel keeps working without changes.
import { db } from "../_firebaseAdmin.js";
import { generateUniqueId } from "../_idGenerator.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { uid, deviceId, email } = req.body || {};
  if (!uid || !deviceId) {
    res.status(400).json({ error: "uid and deviceId are required" });
    return;
  }

  try {
    const ref = db.collection("accessRequests").doc(uid);
    const existing = await ref.get();
    const now = new Date().toISOString();

    const requestNumber =
      existing.exists && existing.data().requestNumber
        ? existing.data().requestNumber
        : await generateUniqueId();
    const status = existing.exists ? existing.data().status : "pending";

    await ref.set(
      {
        name: email || (existing.exists ? existing.data().name : null),
        email: email || (existing.exists ? existing.data().email : null),
        isAccount: true,
        activeDeviceId: deviceId,
        status,
        requestNumber,
        requestedAt: existing.exists ? existing.data().requestedAt : now,
        updatedAt: now,
      },
      { merge: true }
    );

    res.status(200).json({ status, requestNumber, activeDeviceId: deviceId });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
