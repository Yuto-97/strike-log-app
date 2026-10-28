// GET /api/account/device-check?deviceId=yyy
// Headers: Authorization: Bearer <Firebase ID token>
// Polled while a user is signed in. Returns whether `deviceId` is still this
// account's registered active device; if another device has since logged
// in, `active` is false and the caller signs itself out.
// Also returns the account's plan (and this month's counts with &usage=1).
import { db, adminAuth } from "../_firebaseAdmin.js";
import { verifyCaller } from "../_accountAuth.js";
import { effectivePlanId, loadUsed, planView } from "../_plans.js";

export default async function handler(req, res) {
  const caller = await verifyCaller(req, adminAuth);
  if (!caller) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const { deviceId } = req.query;
  if (!deviceId) {
    res.status(400).json({ error: "deviceId is required" });
    return;
  }

  try {
    const doc = await db.collection("accessRequests").doc(caller.uid).get();
    if (!doc.exists) {
      res.status(200).json({ active: false, status: "not_found" });
      return;
    }
    const data = doc.data();
    // The plan comes free with this read; this month's counts (one extra
    // read) only when the app asks with &usage=1 — not on every poll.
    const used = req.query.usage ? await loadUsed(db, caller.uid).catch(() => null) : null;
    res.status(200).json({
      plan: planView(effectivePlanId(data), used, data),
      active: data.activeDeviceId === deviceId,
      status: data.status || "pending",
      requestNumber: data.requestNumber || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
