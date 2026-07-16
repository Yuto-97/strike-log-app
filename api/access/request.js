// POST /api/access/request
// Body: { deviceId, name }
// Creates (or refreshes) a pending access request. If the device was
// already approved, just confirms that back to the client. New requests
// get a random 7-digit ID (digits 1-9 only, no 0) so the admin can find
// people by that ID instead of a long device ID. Checked against existing
// IDs to avoid collisions.
import { db } from "../_firebaseAdmin.js";

const ID_DIGITS = "123456789";

function randomId() {
  let id = "";
  for (let i = 0; i < 7; i++) {
    id += ID_DIGITS[Math.floor(Math.random() * ID_DIGITS.length)];
  }
  return id;
}

async function generateUniqueId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomId();
    const clash = await db.collection("accessRequests").where("requestNumber", "==", candidate).limit(1).get();
    if (clash.empty) return candidate;
  }
  // Extremely unlikely to ever hit this, but fall back to a longer id rather than fail.
  return randomId() + randomId();
}

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
      res.status(200).json({ status: "approved", requestNumber: existing.data().requestNumber || null });
      return;
    }

    const requestNumber = existing.exists && existing.data().requestNumber
      ? existing.data().requestNumber
      : await generateUniqueId();

    const status = existing.exists ? existing.data().status : "pending";
    await ref.set(
      {
        name,
        status,
        requestNumber,
        requestedAt: existing.exists ? existing.data().requestedAt : now,
        updatedAt: now,
      },
      { merge: true }
    );
    res.status(200).json({ status, requestNumber });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
