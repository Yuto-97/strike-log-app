// GET /api/access/status?deviceId=xxx
// Returns { status: "not_found" | "pending" | "approved" | "rejected" }
// With &usage=1 it also returns the person's plan and this month's counts.
import { db } from "../_firebaseAdmin.js";
import { effectivePlanId, loadUsed, planView } from "../_plans.js";

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
    const data = doc.data();
    const planId = effectivePlanId(data);
    const used = req.query.usage ? await loadUsed(db, String(deviceId)).catch(() => null) : null;
    res.status(200).json({ status: data.status, name: data.name, requestNumber: data.requestNumber || null, plan: planView(planId, used) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
