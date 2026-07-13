// POST /api/access/request
// Body: { deviceId, name }
// Creates (or refreshes) a pending access request. If the device was
// already approved, just confirms that back to the client.
import { db } from "../_firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { deviceId, name } = req.body || {};
  if (!deviceId || !name) {
    res.status(400).json({ error: "deviceId and name are required" });
    return;
  }

  try {
    const ref = db.collection("accessRequests").doc(deviceId);
    const existing = await ref.get();
    const now = new Date().toISOString();

    if (existing.exists && existing.data().status === "approved") {
      res.status(200).json({ status: "approved" });
      return;
    }

    const status = existing.exists ? existing.data().status : "pending";
    await ref.set(
      {
        name,
        status,
        requestedAt: existing.exists ? existing.data().requestedAt : now,
        updatedAt: now,
      },
      { merge: true }
    );
    res.status(200).json({ status });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
