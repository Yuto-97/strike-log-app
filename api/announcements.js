// /api/announcements — お知らせ(アップデート情報・イベント広告)
//
// Public:
//   GET  /api/announcements             → currently active announcements (no images)
//   GET  /api/announcements?image=ID&v= → that announcement's image (long-cached)
// Admin (password required, same ADMIN_PASSWORD as the other admin APIs):
//   POST { password, action: "list" }                 → every announcement, incl. scheduled/expired
//   POST { password, action: "save", id?, type, title, body, startDate, endDate, image }
//        image: undefined = keep as is, null = remove, { base64, mediaType } = replace
//   POST { password, action: "delete", id }
//
// Images live in Firestore (announcementImages/{id}) as compressed JPEG
// base64, so the project can stay on Firebase's free Spark plan — Cloud
// Storage now requires the Blaze plan. The admin screen compresses images
// before upload to stay well under Firestore's 1MB-per-document limit.
// If images ever need to be bigger or more numerous, move them to Cloud
// Storage (requires switching Firebase to the Blaze plan).
import { db } from "./_firebaseAdmin.js";

const TYPES = ["update", "event"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITLE = 60;
const MAX_BODY = 1000;
const MAX_IMAGE_B64 = 900000; // ≈ 675KB of JPEG — comfortably under the 1MB doc limit

// Dates are compared as Japan-time calendar days (YYYY-MM-DD).
export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function isActive(a, today) {
  return (!a.startDate || a.startDate <= today) && (!a.endDate || a.endDate >= today);
}

const byNewest = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));

function bad(res, message) {
  res.status(400).json({ error: message });
}

export function createHandler({ db, adminPassword, now = () => Date.now() }) {
  const col = () => db.collection("announcements");
  const imgCol = () => db.collection("announcementImages");

  return async function handler(req, res) {
    try {
      if (req.method === "GET") {
        const imageId = req.query?.image;
        if (imageId) {
          if (!ID.test(String(imageId))) return bad(res, "invalid id");
          const doc = await imgCol().doc(String(imageId)).get();
          if (!doc.exists) {
            res.status(404).json({ error: "not found" });
            return;
          }
          const { data, mediaType } = doc.data();
          // The app asks with ?v=<updatedAt>, so a replaced image gets a new
          // URL — safe to let phones and Vercel's edge cache it for a long time.
          res.setHeader("Content-Type", mediaType || "image/jpeg");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.status(200).send(Buffer.from(data, "base64"));
          return;
        }
        const snap = await col().get();
        const today = todayJst(now());
        const items = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((a) => isActive(a, today))
          .sort(byNewest);
        res.setHeader("Cache-Control", "public, max-age=60");
        res.status(200).json({ items });
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ error: "GET or POST only" });
        return;
      }

      const body = req.body || {};
      if (!adminPassword || body.password !== adminPassword) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      if (body.action === "list") {
        const snap = await col().get();
        const today = todayJst(now());
        const items = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .map((a) => ({ ...a, active: isActive(a, today) }))
          .sort(byNewest);
        res.status(200).json({ items, today });
        return;
      }

      if (body.action === "delete") {
        if (!ID.test(String(body.id || ""))) return bad(res, "invalid id");
        await col().doc(body.id).delete();
        await imgCol().doc(body.id).delete();
        res.status(200).json({ ok: true });
        return;
      }

      if (body.action === "save") {
        const type = body.type;
        const title = String(body.title || "").trim();
        const text = String(body.body || "").trim();
        const startDate = body.startDate || null;
        const endDate = body.endDate || null;

        if (!TYPES.includes(type)) return bad(res, "種類を選んでください");
        if (!title || title.length > MAX_TITLE) return bad(res, `タイトルは1〜${MAX_TITLE}文字で入力してください`);
        if (text.length > MAX_BODY) return bad(res, `本文は${MAX_BODY}文字以内にしてください`);
        if (startDate && !DATE.test(startDate)) return bad(res, "開始日の形式が正しくありません");
        if (endDate && !DATE.test(endDate)) return bad(res, "終了日の形式が正しくありません");
        if (type === "event" && !endDate) return bad(res, "イベントは終了日(応募締切など)を入力してください");
        if (startDate && endDate && endDate < startDate) return bad(res, "終了日が開始日より前になっています");

        const image = body.image;
        if (image && (typeof image.base64 !== "string" || image.base64.length > MAX_IMAGE_B64)) {
          return bad(res, "画像が大きすぎます。別の画像でお試しください");
        }

        const stamp = new Date(now()).toISOString();
        let id = body.id;
        let existing = null;
        if (id) {
          if (!ID.test(String(id))) return bad(res, "invalid id");
          const doc = await col().doc(id).get();
          if (!doc.exists) return bad(res, "このお知らせは削除されています");
          existing = doc.data();
        } else {
          id = col().doc().id;
        }

        const record = {
          type,
          title,
          body: text,
          startDate,
          endDate,
          hasImage: existing ? !!existing.hasImage : false,
          imageVersion: existing ? existing.imageVersion || null : null,
          createdAt: existing ? existing.createdAt : stamp,
          updatedAt: stamp,
        };
        if (image) {
          await imgCol().doc(id).set({ data: image.base64, mediaType: image.mediaType || "image/jpeg" });
          record.hasImage = true;
          record.imageVersion = stamp;
        } else if (image === null) {
          await imgCol().doc(id).delete();
          record.hasImage = false;
          record.imageVersion = null;
        }
        await col().doc(id).set(record);
        res.status(200).json({ ok: true, id });
        return;
      }

      bad(res, "unknown action");
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  };
}

export default createHandler({ db, adminPassword: process.env.ADMIN_PASSWORD });
