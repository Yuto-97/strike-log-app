// /api/data — cloud copy of an account holder's records, so they follow the
// person to a new phone.
//
//   GET  → { games: [...], kv: { "my-balls": "...", ... } }
//   POST { upserts: [game], deletes: [gameId], kv: { key: value|null } }
//
// Headers: Authorization: Bearer <Firebase ID token>, X-Device-Id: <device>
//
// Access rules, checked on every request:
//   - the caller is identified only from the verified ID token
//   - the account must be approved by the admin
//   - the request must come from the account's current active device —
//     otherwise 409, and the app signs that device out (one account, one
//     device at a time)
//
// Storage layout: userData/{uid} holds the small settings (balls, shoes,
// profile...) and userData/{uid}/games/{gameId} holds one document per game.
// One doc per game keeps us far from Firestore's 1MB-per-document limit no
// matter how many games someone records, and lets each save write only what
// changed. Each game is stored as a JSON string, which sidesteps Firestore's
// restrictions on nested arrays and undefined values.
import { db, adminAuth, FieldValue } from "./_firebaseAdmin.js";
import { verifyCaller } from "./_accountAuth.js";

export const SYNCED_KV_KEYS = ["my-balls", "my-shoes", "profile", "player-name", "ball-config", "shoe-config"];
const MAX_GAMES_PER_REQUEST = 300;
const MAX_GAME_BYTES = 30000;
const MAX_KV_BYTES = 200000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_LIMIT = 400; // Firestore allows 500 writes per batch

export function createHandler({ db, adminAuth, FieldValue }) {
  return async function handler(req, res) {
    const caller = await verifyCaller(req, adminAuth);
    if (!caller) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const deviceId = req.headers["x-device-id"];

    let account;
    try {
      const acc = await db.collection("accessRequests").doc(caller.uid).get();
      account = acc.exists ? acc.data() : null;
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
      return;
    }
    if (!account || account.status !== "approved") {
      res.status(403).json({ error: "not_approved" });
      return;
    }
    if (!deviceId || account.activeDeviceId !== deviceId) {
      res.status(409).json({ error: "inactive_device" });
      return;
    }

    const userRef = db.collection("userData").doc(caller.uid);

    if (req.method === "GET") {
      try {
        const [doc, snap] = await Promise.all([userRef.get(), userRef.collection("games").get()]);
        const games = [];
        for (const d of snap.docs) {
          try {
            games.push(JSON.parse(d.data().json));
          } catch (e) {
            // skip a corrupted record rather than failing the whole load
          }
        }
        const kv = doc.exists ? doc.data().kv || {} : {};
        res.status(200).json({ games, kv });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "GET or POST only" });
      return;
    }

    const body = req.body || {};
    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    const kvIn = body.kv && typeof body.kv === "object" ? body.kv : {};

    if (upserts.length + deletes.length > MAX_GAMES_PER_REQUEST) {
      res.status(413).json({ error: "too_many_games" });
      return;
    }

    const ops = [];
    for (const g of upserts) {
      if (!g || typeof g.id !== "string" || !ID_PATTERN.test(g.id)) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      const json = JSON.stringify(g);
      if (json.length > MAX_GAME_BYTES) {
        res.status(413).json({ error: "game_too_large" });
        return;
      }
      ops.push((batch) =>
        batch.set(userRef.collection("games").doc(g.id), { json, updatedAt: new Date().toISOString() })
      );
    }
    for (const id of deletes) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      ops.push((batch) => batch.delete(userRef.collection("games").doc(id)));
    }

    const kvUpdate = {};
    for (const [key, value] of Object.entries(kvIn)) {
      if (!SYNCED_KV_KEYS.includes(key)) continue;
      if (value === null) {
        kvUpdate[key] = FieldValue.delete();
      } else if (typeof value === "string" && value.length <= MAX_KV_BYTES) {
        kvUpdate[key] = value;
      }
    }
    if (Object.keys(kvUpdate).length) {
      ops.push((batch) => batch.set(userRef, { kv: kvUpdate, updatedAt: new Date().toISOString() }, { merge: true }));
    }

    try {
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        ops.slice(i, i + BATCH_LIMIT).forEach((op) => op(batch));
        await batch.commit();
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  };
}

export default createHandler({ db, adminAuth, FieldValue });
