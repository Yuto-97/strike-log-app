// GET /api/account/device-check?uid=xxx&deviceId=yyy
// Polled periodically by the app while a user is logged into an account.
// Returns whether `deviceId` is still this account's registered active
// device. If another device has since logged into the same account,
// `active` comes back false and the caller should sign itself out.
import { db } from "../_firebaseAdmin.js";

export default async function handler(req, res) {
  const { uid, deviceId } = req.query;
  if (!uid || !deviceId) {
    res.status(400).json({ error: "uid and deviceId are required" });
    return;
  }

  try {
    const doc = await db.collection("accessRequests").doc(String(uid)).get();
    if (!doc.exists) {
      res.status(200).json({ active: false, status: "not_found" });
      return;
    }
    const data = doc.data();
    res.status(200).json({
      active: data.activeDeviceId === deviceId,
      status: data.status || "pending",
      requestNumber: data.requestNumber || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
