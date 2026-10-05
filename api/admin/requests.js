// GET    /api/admin/requests?password=xxx                 -> list all access requests
// POST   /api/admin/requests { password, deviceId, status } -> approve/reject
// DELETE /api/admin/requests { password, deviceId }          -> delete a request
// GET    /api/admin/requests?password=xxx&view=usage&month=YYYY-MM
//                                        -> AI usage & costs for a month (per user + totals)
// POST   /api/admin/requests { password, action: "finance", month, fixedCosts, revenueJpy, usdJpy }
//                                        -> save that month's fixed costs / revenue, and the USD→JPY rate
// Fixed costs carry forward automatically: a month with nothing saved uses
// the most recent earlier month that has them. Items may be in yen or in
// dollars ({ label, amount, currency: "JPY" | "USD" }); dollar items are
// converted with the saved exchange rate. Older yen-only items
// ({ label, amountJpy }) are still read correctly.
// (Usage/cost lives here rather than in a new function to stay within
// Vercel's function-count limit on the free plan.)
import { db, adminAuth } from "../_firebaseAdmin.js";
import { isAdminRequest } from "../_adminAuth.js";
import { generateUniqueId } from "../_idGenerator.js";
import { monthJST } from "../_usage.js";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DEFAULT_USD_JPY = 150;

function prevMonth(m, back = 1) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 - back, 1));
  return d.toISOString().slice(0, 7);
}

const CARRY_BACK_MONTHS = 24;

// Accepts both the current shape and the older { label, amountJpy } shape.
export function normalizeFixedItem(x) {
  const currency = x && x.currency === "USD" ? "USD" : "JPY";
  const raw = Number(x && x.amount !== undefined ? x.amount : x && x.amountJpy);
  const amount = Number.isFinite(raw) && raw >= 0 ? (currency === "USD" ? Math.round(raw * 100) / 100 : Math.round(raw)) : 0;
  return { label: String((x && x.label) || "").trim().slice(0, 40), amount, currency };
}

export function fixedItemJpy(item, usdJpy) {
  return item.currency === "USD" ? Math.round(item.amount * usdJpy * 10) / 10 : item.amount;
}

// The fixed costs in effect for a month: its own saved list, or else the
// latest earlier month's. `from` is the month the list actually came from.
async function effectiveFixedCosts(month, cache) {
  for (let i = 0; i <= CARRY_BACK_MONTHS; i++) {
    const m = prevMonth(month, i);
    if (!cache.has(m)) cache.set(m, db.collection("financeMonths").doc(m).get());
    const d = await cache.get(m);
    if (d.exists && Array.isArray(d.data().fixedCosts)) {
      return { items: d.data().fixedCosts.map(normalizeFixedItem), from: m };
    }
  }
  return { items: [], from: null };
}

// Service problems the owner needs to fix (API credits ran out, API key
// broken) that happened after they last pressed "対応した".
async function activeAlerts() {
  try {
    const snap = await db.collection("alerts").get();
    return snap.docs
      .map((d) => d.data())
      .filter((a) => a.lastAt && (!a.ackAt || a.lastAt > a.ackAt))
      .map((a) => ({ kind: a.kind, lastAt: a.lastAt, count: a.count || 0 }));
  } catch (e) {
    return [];
  }
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

  const fin = finDoc.exists ? finDoc.data() : null;
  const usdJpy = settingsDoc.exists ? Number(settingsDoc.data().usdJpy) || DEFAULT_USD_JPY : DEFAULT_USD_JPY;
  const cache = new Map();
  const current = await effectiveFixedCosts(month, cache);

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
        fixedCostJpy: (await effectiveFixedCosts(m, cache)).items.reduce((s, x) => s + fixedItemJpy(x, usdJpy), 0),
        revenueJpy: Number(fd.revenueJpy) || 0,
      };
    })
  );

  return {
    month,
    currentMonth: monthJST(),
    totals: totalsDoc.exists ? totalsDoc.data() : {},
    users,
    fixedCosts: current.items,
    fixedCostsFrom: current.from, // same as `month` if saved for this month; earlier month if carried forward
    revenueJpy: fin ? Number(fin.revenueJpy) || 0 : 0,
    usdJpy,
    history: hist,
  };
}


export default async function handler(req, res) {
  if (!(await isAdminRequest(req, { db, adminAuth }))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET" && req.query.view === "usage") {
      const month = MONTH_RE.test(req.query.month || "") ? req.query.month : monthJST();
      res.status(200).json(await usageView(month));
      return;
    }

    // Remove someone from (or restore them to) the monthly ranking.
    if (req.method === "POST" && (req.body || {}).action === "rankingExclude") {
      const { uid, excluded } = req.body;
      if (!uid || typeof uid !== "string" || uid.includes("/")) {
        res.status(400).json({ error: "uid is required" });
        return;
      }
      await db.collection("rankingParticipants").doc(uid).set({ excluded: !!excluded, updatedAt: new Date().toISOString() }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "POST" && (req.body || {}).action === "ackAlerts") {
      const now = new Date().toISOString();
      const snap = await db.collection("alerts").get();
      const batch = db.batch();
      snap.docs.forEach((d) => batch.set(d.ref, { ackAt: now }, { merge: true }));
      await batch.commit();
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "POST" && (req.body || {}).action === "finance") {
      const { month, fixedCosts, revenueJpy, usdJpy } = req.body;
      if (!MONTH_RE.test(month || "")) {
        res.status(400).json({ error: "month is required" });
        return;
      }
      const items = (Array.isArray(fixedCosts) ? fixedCosts : [])
        .map(normalizeFixedItem)
        .filter((x) => x.label)
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
      // ランキング: who takes part, and who the admin has removed
      try {
        const parts = await db.collection("rankingParticipants").get();
        const byId = new Map(parts.docs.map((x) => [x.id, x.data()]));
        for (const it of items) {
          const p = byId.get(it.id);
          if (p) {
            it.rankingOptIn = !!p.optIn;
            it.rankingExcluded = !!p.excluded;
            it.rankingNickname = p.nickname || "";
          }
        }
      } catch (e) {
        // ranking info is optional for this list
      }
      res.status(200).json({ items, alerts: await activeAlerts() });
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
