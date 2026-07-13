// GET /api/access/status?deviceId=xxx
// Returns { status: "not_found" | "pending" | "approved" | "rejected" }
import { db } from "../_firebaseAdmin.js";

export default async function handler(req, res) {
  const deviceId = req.query.deviceId;
  if (!deviceId) {
    res.status(400).json({ error: "deviceId is required" });
    return;
  }

  try {
    const doc = await db.collection("accessRequests").doc(String(deviceId)).get();
    if (!doc.exists) {
      res.status(200).json({ status: "not_found" });
      return;
    }
    res.status(200).json({ status: doc.data().status, name: doc.data().name });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
