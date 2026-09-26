// GET    /api/admin/requests?password=xxx                 -> list all access requests
// POST   /api/admin/requests { password, deviceId, status } -> approve/reject
// DELETE /api/admin/requests { password, deviceId }          -> delete a request
// GET    /api/admin/requests?password=xxx&view=usage&month=YYYY-MM
//                                        -> AI usage & costs for a month (per user + totals)
// POST   /api/admin/requests { password, action: "finance", month, fixedCosts, revenueJpy, usdJpy }
//                                        -> save that month's fixed costs / revenue, and the USD→JPY rate
// (Usage/cost lives here rather than in a new function to stay within
// Vercel's function-count limit on the free plan.)
import { db } from "../_firebaseAdmin.js";
import { generateUniqueId } from "../_idGenerator.js";
import { monthJST } from "../_usage.js";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DEFAULT_USD_JPY = 150;

function prevMonth(m, back = 1) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 - back, 1));
  return d.toISOString().slice(0, 7);
}

async function usageView(month) {
  const monthRef = db.collection("usageMonths").doc(month);
  const [totalsDoc, usersSnap, reqSnap, lastSnap, finDoc, settingsDoc] = await Promise.all([
    monthRef.get(),
    monthRef.collection("users").get(),
    db.collection("accessRequests").get(),
    db.collection("usageUsers").get(),
    db.collection("financeMonths").doc(month).get(),
    db.collection("settings").doc("finance").get(),
  ]);
  const people = new Map(reqSnap.docs.map((d) => [d.id, d.data()]));
  const lastUsed = new Map(lastSnap.docs.map((d) => [d.id, d.data().lastUsedAt || null]));

  const users = usersSnap.docs.map((d) => {
    const p = people.get(d.id) || {};
    return {
      key: d.id,
      name: p.name || null,
      requestNumber: p.requestNumber || null,
      isAccount: !!p.isAccount,
      status: p.status || null,
      ...d.data(),
      lastUsedAt: lastUsed.get(d.id) || d.data().lastUsedAt || null,
    };
  });
  // Approved people with no usage this month still matter ("stopped using").
  for (const [id, p] of people) {
    if (p.status === "approved" && !users.some((u) => u.key === id)) {
      users.push({ key: id, name: p.name || null, requestNumber: p.requestNumber || null, isAccount: !!p.isAccount, status: p.status, lastUsedAt: lastUsed.get(id) || null });
    }
  }

  let fin = finDoc.exists ? finDoc.data() : null;
  let suggestedFixedCosts = null;
  if (!fin || !Array.isArray(fin.fixedCosts)) {
    for (let i = 1; i <= 12 && !suggestedFixedCosts; i++) {
      const d = await db.collection("financeMonths").doc(prevMonth(month, i)).get();
      if (d.exists && Array.isArray(d.data().fixedCosts) && d.data().fixedCosts.length) suggestedFixedCosts = d.data().fixedCosts;
    }
  }

  const months = [0, 1, 2, 3, 4, 5].map((i) => prevMonth(month, i));
  const hist = await Promise.all(
    months.map(async (m) => {
      const [u, f] = await Promise.all([db.collection("usageMonths").doc(m).get(), db.collection("financeMonths").doc(m).get()]);
      const fd = f.exists ? f.data() : {};
      return {
        month: m,
        aiCostUsd: u.exists ? u.data().costUsd || 0 : 0,
        analyzeCount: u.exists ? u.data().analyzeCount || 0 : 0,
        chatCount: u.exists ? u.data().chatCount || 0 : 0,
        fixedCostJpy: (fd.fixedCosts || []).reduce((s, x) => s + (Number(x.amountJpy) || 0), 0),
        revenueJpy: Number(fd.revenueJpy) || 0,
      };
    })
  );

  return {
    month,
    currentMonth: monthJST(),
    totals: totalsDoc.exists ? totalsDoc.data() : {},
    users,
    fixedCosts: fin && Array.isArray(fin.fixedCosts) ? fin.fixedCosts : [],
    revenueJpy: fin ? Number(fin.revenueJpy) || 0 : 0,
    suggestedFixedCosts,
    usdJpy: settingsDoc.exists ? Number(settingsDoc.data().usdJpy) || DEFAULT_USD_JPY : DEFAULT_USD_JPY,
    history: hist,
  };
}

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
    if (req.method === "GET" && req.query.view === "usage") {
      const month = MONTH_RE.test(req.query.month || "") ? req.query.month : monthJST();
      res.status(200).json(await usageView(month));
      return;
    }

    if (req.method === "POST" && (req.body || {}).action === "finance") {
      const { month, fixedCosts, revenueJpy, usdJpy } = req.body;
      if (!MONTH_RE.test(month || "")) {
        res.status(400).json({ error: "month is required" });
        return;
      }
      const items = (Array.isArray(fixedCosts) ? fixedCosts : [])
        .map((x) => ({ label: String(x?.label || "").trim().slice(0, 40), amountJpy: Math.round(Number(x?.amountJpy) || 0) }))
        .filter((x) => x.label && x.amountJpy >= 0)
        .slice(0, 30);
      const now = new Date().toISOString();
      const batch = db.batch();
      batch.set(db.collection("financeMonths").doc(month), { fixedCosts: items, revenueJpy: Math.max(0, Math.round(Number(revenueJpy) || 0)), updatedAt: now });
      const rate = Number(usdJpy);
      if (rate > 50 && rate < 500) batch.set(db.collection("settings").doc("finance"), { usdJpy: rate, updatedAt: now }, { merge: true });
      await batch.commit();
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "GET") {
      const snap = await db.collection("accessRequests").orderBy("requestedAt", "desc").get();
      const items = [];
      for (const d of snap.docs) {
        const data = d.data();
        if (!data.requestNumber) {
          // Backfill: older records created before ID numbers existed.
          const requestNumber = await generateUniqueId();
          await d.ref.set({ requestNumber }, { merge: true });
          data.requestNumber = requestNumber;
        }
        items.push({ id: d.id, ...data });
      }
      res.status(200).json({ items });
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
