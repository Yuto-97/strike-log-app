// GET    /api/admin/requests?password=xxx                 -> list all access requests
// POST   /api/admin/requests { password, deviceId, status } -> approve/reject
// DELETE /api/admin/requests { password, deviceId }          -> delete a request
import { db } from "../_firebaseAdmin.js";

function isAuthed(req) {
  const password = req.method === "GET" ? req.query.password : (req.body || {}).password;
  return !!process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      const snap = await db.collection("accessRequests").orderBy("requestedAt", "desc").get();
      res.status(200).json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
      return;
    }

    if (req.method === "POST") {
      const { deviceId, status } = req.body || {};
      if (!deviceId || !["approved", "rejected", "pending"].includes(status)) {
        res.status(400).json({ error: "deviceId and a valid status are required" });
        return;
      }
      await db
        .collection("accessRequests")
        .doc(deviceId)
        .set({ status, updatedAt: new Date().toISOString() }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "DELETE") {
      const { deviceId } = req.body || {};
      if (!deviceId) {
        res.status(400).json({ error: "deviceId is required" });
        return;
      }
      await db.collection("accessRequests").doc(deviceId).delete();
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "GET, POST, or DELETE only" });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
