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

// ---------- 月間ランキング ----------
// Only the final score read from the photo (photoTotal) counts — editing the
// frames by hand can't change it. Games without a photo-read score, and
// repeat uploads of the same photo (same photoKey), are left out.
export const RANKING_MIN_GAMES_FOR_AVERAGE = 3;
export const RANKING_TOP = 30;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function rankingSummary(gamesList) {
  const seen = new Set();
  const scores = [];
  for (const g of [...gamesList].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0))) {
    // Must be an actual number: an empty value would otherwise turn into 0.
    if (!g || typeof g.photoTotal !== "number") continue;
    const s = g.photoTotal;
    if (!Number.isFinite(s) || s < 0 || s > 300) continue;
    if (g.photoKey) {
      if (seen.has(g.photoKey)) continue;
      seen.add(g.photoKey);
    }
    scores.push(s);
  }
  if (!scores.length) return null;
  return {
    games: scores.length,
    avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    high: Math.max(...scores),
  };
}

// The month's summary for all games, plus separately for games whose 1st
// ball was a ハウスボール or a マイボール (for the ball filter).
export function rankingSummaryByBall(gamesList) {
  const all = rankingSummary(gamesList);
  if (!all) return null;
  const typeOf = (g) => (g && g.ball && g.ball.type === "house" ? "house" : g && g.ball && g.ball.type === "own" ? "own" : null);
  return {
    ...all,
    byBall: {
      house: rankingSummary(gamesList.filter((g) => typeOf(g) === "house")),
      own: rankingSummary(gamesList.filter((g) => typeOf(g) === "own")),
    },
  };
}

export const RANKING_AGE_GROUPS = ["10s", "20s", "30s", "40s", "50s", "60s", "70s+"];
export const RANKING_GENDERS = ["male", "female"];
const cleanAge = (v) => (RANKING_AGE_GROUPS.includes(v) ? v : null);
const cleanGender = (v) => (RANKING_GENDERS.includes(v) ? v : null);

// Competition ranking (1, 2, 2, 4…). Returns the top N plus the caller's own
// row if they're further down. Rows never include anyone's id.
export function buildRanking(rows, valueOf, myUid) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a) || (b.games || 0) - (a.games || 0));
  let lastValue = null;
  let lastRank = 0;
  const ranked = sorted.map((r, i) => {
    const v = valueOf(r);
    const rank = v === lastValue ? lastRank : i + 1;
    lastValue = v;
    lastRank = rank;
    return { rank, nickname: r.nickname, value: v, games: r.games, isMe: r.uid === myUid };
  });
  const top = ranked.slice(0, RANKING_TOP);
  const me = ranked.find((r) => r.isMe);
  return { top, me: me && !top.includes(me) ? me : null, total: ranked.length };
}

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

    if (req.method === "GET" && req.query && req.query.ranking) {
      const month = String(req.query.ranking);
      if (!MONTH_RE.test(month)) {
        res.status(400).json({ error: "invalid month" });
        return;
      }
      try {
        const [entriesSnap, partsSnap] = await Promise.all([
          db.collection("rankingMonths").doc(month).collection("entries").get(),
          db.collection("rankingParticipants").get(),
        ]);
        // Filters: 年代 / 性別 / ボール (ハウス・マイ). People who didn't set an
        // age group or gender only appear when that filter is 「すべて」.
        const age = cleanAge(String(req.query.age || ""));
        const gender = cleanGender(String(req.query.gender || ""));
        const ball = ["house", "own"].includes(String(req.query.ball || "")) ? String(req.query.ball) : null;
        const pick = (e) => (ball ? (e.byBall && e.byBall[ball]) || null : e);

        const parts = new Map(partsSnap.docs.map((d) => [d.id, d.data()]));
        const entries = entriesSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        const visible = entries
          .filter((e) => {
            const p = parts.get(e.uid);
            if (!p || !p.optIn || p.excluded || !p.nickname) return false;
            if (age && p.ageGroup !== age) return false;
            if (gender && p.gender !== gender) return false;
            return !!pick(e);
          })
          .map((e) => ({ ...pick(e), uid: e.uid, nickname: parts.get(e.uid).nickname }));
        const mineRaw = entries.find((e) => e.uid === caller.uid) || null;
        const mine = mineRaw ? pick(mineRaw) : null;
        const myPart = parts.get(caller.uid) || {};
        res.status(200).json({
          month,
          filters: { age, gender, ball },
          minGames: RANKING_MIN_GAMES_FOR_AVERAGE,
          average: buildRanking(visible.filter((e) => e.games >= RANKING_MIN_GAMES_FOR_AVERAGE), (e) => e.avg, caller.uid),
          high: buildRanking(visible, (e) => e.high, caller.uid),
          me: {
            optIn: !!myPart.optIn,
            excluded: !!myPart.excluded,
            games: mine ? mine.games : 0,
            avg: mine ? mine.avg : null,
            high: mine ? mine.high : null,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

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
    const months = new Set(); // months whose ranking summary must be recalculated
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
      if (typeof g.date === "string" && /^\d{4}-\d{2}/.test(g.date)) months.add(g.date.slice(0, 7));
      ops.push((batch) =>
        batch.set(userRef.collection("games").doc(g.id), {
          json,
          date: typeof g.date === "string" ? g.date : null, // lets a month's games be looked up
          updatedAt: new Date().toISOString(),
        })
      );
    }
    for (const id of deletes) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      ops.push((batch) => batch.delete(userRef.collection("games").doc(id)));
    }
    // a deleted game's month also needs recalculating
    for (const id of deletes) {
      try {
        const d = await userRef.collection("games").doc(id).get();
        if (d.exists) {
          const date = d.data().date || (JSON.parse(d.data().json || "{}").date ?? null);
          if (typeof date === "string") months.add(date.slice(0, 7));
        }
      } catch (e) {
        // unreadable record: nothing to recalculate
      }
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
    if (typeof kvIn.profile === "string") {
      try {
        const prof = JSON.parse(kvIn.profile);
        // ランキング表示名 is separate from the app nickname.
        const nickname = String(prof.rankingName || "").trim().slice(0, 20);
        ops.push((batch) =>
          batch.set(
            db.collection("rankingParticipants").doc(caller.uid),
            {
              nickname,
              optIn: !!prof.rankingOptIn,
              ageGroup: cleanAge(prof.ageGroup),
              gender: cleanGender(prof.gender),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          )
        );
        // Joining (or changing settings) also refreshes this month's and last
        // month's totals, so ones saved before this version get the ball split.
        const now = new Date(Date.now() + 9 * 3600 * 1000); // Japan time
        const thisM = now.toISOString().slice(0, 7);
        const lastM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        months.add(thisM);
        months.add(lastM);
      } catch (e) {
        // malformed profile: ignore for ranking purposes
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
      for (const m of months) {
        if (!MONTH_RE.test(m)) continue;
        const snap = await userRef.collection("games").where("date", ">=", `${m}-01`).where("date", "<=", `${m}-31`).get();
        const list = [];
        for (const d of snap.docs) {
          try {
            list.push(JSON.parse(d.data().json));
          } catch (e) {
            // skip corrupted
          }
        }
        const sum = rankingSummaryByBall(list);
        const ref = db.collection("rankingMonths").doc(m).collection("entries").doc(caller.uid);
        if (sum) await ref.set({ ...sum, updatedAt: new Date().toISOString() });
        else await ref.delete();
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  };
}

export default createHandler({ db, adminAuth, FieldValue });
