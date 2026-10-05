// GET    /api/admin/feedback?password=xxx                 -> list all feedback
// POST   /api/admin/feedback { password, id, status }      -> update handled status
// DELETE /api/admin/feedback { password, id }               -> delete a feedback item
import { db, adminAuth } from "../_firebaseAdmin.js";
import { isAdminRequest } from "../_adminAuth.js";


export default async function handler(req, res) {
  if (!(await isAdminRequest(req, { db, adminAuth }))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      const snap = await db.collection("feedback").orderBy("createdAt", "desc").get();
      res.status(200).json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
      return;
    }

    if (req.method === "POST") {
      const { id, status } = req.body || {};
      if (!id || !["handled", "unhandled"].includes(status)) {
        res.status(400).json({ error: "id and a valid status are required" });
        return;
      }
      await db.collection("feedback").doc(id).set({ status }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "DELETE") {
      const { id } = req.body || {};
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      await db.collection("feedback").doc(id).delete();
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "GET, POST, or DELETE only" });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
