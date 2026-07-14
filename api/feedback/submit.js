// POST /api/feedback/submit
// Body: { deviceId, name, message }
import { db } from "../_firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { deviceId, name, message } = req.body || {};
  if (!message || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    await db.collection("feedback").add({
      deviceId: deviceId || null,
      name: name || "",
      message: message.trim(),
      status: "unhandled",
      createdAt: new Date().toISOString(),
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
