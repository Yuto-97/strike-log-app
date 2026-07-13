// GET /api/admin/feedback?password=xxx -> list all feedback submissions
import { db } from "../_firebaseAdmin.js";

export default async function handler(req, res) {
  const password = req.query.password;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const snap = await db.collection("feedback").orderBy("createdAt", "desc").get();
    res.status(200).json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
