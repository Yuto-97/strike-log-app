// POST /api/access/request
// Body: { deviceId, name }
// Creates (or refreshes) a pending access request. If the device was
// already approved, just confirms that back to the client. New requests
// get a short sequential number (via a transactional counter) so the
// admin can find people by "No.3" instead of a long device ID.
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

    let requestNumber = existing.exists ? existing.data().requestNumber : null;
    if (!requestNumber) {
      const counterRef = db.collection("meta").doc("counters");
      requestNumber = await db.runTransaction(async (tx) => {
        const counterDoc = await tx.get(counterRef);
        const next = (counterDoc.exists ? counterDoc.data().requestNumber : 0) + 1;
        tx.set(counterRef, { requestNumber: next }, { merge: true });
        return next;
      });
    }

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
    res.status(200).json({ status });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
