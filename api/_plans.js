// Paid plans: what each one includes, and the monthly-limit check used by
// the AI endpoints (score analysis, support chat).
//
// A person's plan is the `plan` field on their accessRequests doc (keyed by
// the account uid, or the device id for device-only users — the same key the
// usage records use). Until payments go live it's set by hand from the admin
// screen; later Stripe will set it.
//
// Nobody is affected until a plan is set for them: people with no plan get
// "legacy" — exactly how the app worked before plans existed (no limits, all
// current features, but not the new auto row-finding). Once PLANS_ENABLED=1
// is set in Vercel (when Stripe goes live), people with no plan are treated
// as ベーシック instead.
//
// Monthly counts reset on the 1st (Japan time). Only successful calls count;
// the auto row-finding step is part of one analysis and never counts.
import { monthJST } from "./_usage.js";

export const PLANS = {
  basic: { label: "ベーシック", analyze: 40, chat: 30, premiumStats: false, autoLocate: false },
  premium: { label: "プレミアム", analyze: 100, chat: 30, premiumStats: true, autoLocate: true },
  free: { label: "招待(無料)", analyze: null, chat: null, premiumStats: true, autoLocate: true },
  legacy: { label: "未設定", analyze: null, chat: null, premiumStats: true, autoLocate: false },
};

// 追加パック: extra score readings bought on top of the monthly allowance.
// Added the moment they're bought; used only after the month's own count is
// used up (so nothing in the monthly allowance is wasted); unused readings
// carry over until 6 months after purchase. Stored on the accessRequests doc
// as packs: [{ id, count, used, purchasedAt, expiresAt }].
export const PACK = { count: 20, price: 500, months: 6 };

function jstDateLabel(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

// Usable packs, the one expiring soonest first.
export function activePacks(doc, now = new Date()) {
  const list = doc && Array.isArray(doc.packs) ? doc.packs : [];
  return list
    .filter((p) => p && (p.count || 0) - (p.used || 0) > 0 && new Date(p.expiresAt) > now)
    .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
}

export function packSummary(doc, now = new Date()) {
  const act = activePacks(doc, now);
  const remaining = act.reduce((a, p) => a + (p.count || 0) - (p.used || 0), 0);
  const month = monthJST(now);
  const boughtThisMonth = (doc && Array.isArray(doc.packs) ? doc.packs : []).filter((p) => p && monthJST(new Date(p.purchasedAt)) === month).length;
  return { remaining, expiresOn: act.length ? jstDateLabel(act[0].expiresAt) : null, boughtThisMonth };
}

// A new pack record (used by the admin screen now, by Stripe later).
export function newPack(now = new Date()) {
  const exp = new Date(now);
  exp.setMonth(exp.getMonth() + PACK.months);
  return { id: `p${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, count: PACK.count, used: 0, purchasedAt: now.toISOString(), expiresAt: exp.toISOString() };
}

// Uses one reading from the pack that expires soonest. Called only after a
// successful analysis that went past the monthly allowance.
export async function consumePack(db, key, now = new Date()) {
  const ref = db.collection("accessRequests").doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = snap.data();
    const target = activePacks(doc, now)[0];
    if (!target) return packSummary(doc, now);
    const packs = doc.packs.map((p) => (p.id === target.id ? { ...p, used: (p.used || 0) + 1 } : p));
    tx.update(ref, { packs });
    return packSummary({ ...doc, packs }, now);
  });
}

// Plans the admin can assign (legacy = "clear the setting").
export const ASSIGNABLE_PLANS = ["basic", "premium", "free"];

export function plansEnabled() {
  return process.env.PLANS_ENABLED === "1";
}

export function effectivePlanId(requestDoc) {
  // プレミアム＋ was discontinued (2026-10): anyone still set to it is treated as プレミアム.
  const p = requestDoc && requestDoc.plan === "premium_plus" ? "premium" : requestDoc && requestDoc.plan;
  if (p && ASSIGNABLE_PLANS.includes(p)) return p;
  return plansEnabled() ? "basic" : "legacy";
}

export function nextResetLabel(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() === 11 ? 1 : jst.getUTCMonth() + 2}月1日`;
}

// What the app is told about a person's plan.
export function planView(planId, used, doc = null) {
  const p = PLANS[planId] || PLANS.legacy;
  return {
    pack: { ...PACK, ...packSummary(doc), purchasable: false }, // purchasable once Stripe is live
    id: planId,
    label: p.label,
    premiumStats: p.premiumStats,
    autoLocate: p.autoLocate,
    limits: { analyze: p.analyze, chat: p.chat },
    used: used ? { analyze: used.analyze || 0, chat: used.chat || 0 } : null,
    resetsOn: nextResetLabel(),
  };
}

export async function loadUsed(db, key, now = new Date()) {
  const snap = await db.collection("usageMonths").doc(monthJST(now)).collection("users").doc(key).get();
  const d = snap.exists ? snap.data() : {};
  return { analyze: d.analyzeOk || 0, chat: d.chatOk || 0 };
}

// Reads the plan + this month's counts for one person.
export async function loadPlanState(db, key, { withUsage = true } = {}) {
  const doc = await db.collection("accessRequests").doc(key).get();
  const data = doc.exists ? doc.data() : null;
  const planId = effectivePlanId(data);
  const used = withUsage ? await loadUsed(db, key) : null;
  return { planId, used, doc: data };
}

// Called before an AI request. feature: "analyze" | "chat" | "locate".
// Returns { ok: true, planId, used, limit } or { ok: false, status, body }.
export async function checkAllowance({ db, caller, feature }) {
  if (!caller) {
    return plansEnabled() ? { ok: false, status: 401, body: { error: "unidentified" } } : { ok: true, planId: "legacy", used: null, limit: null };
  }
  const { planId, used, doc } = await loadPlanState(db, caller.key);
  const plan = PLANS[planId];
  if (feature === "recheck") return { ok: true, planId, used, limit: null };
  if (feature === "locate") {
    return plan.autoLocate ? { ok: true, planId, used, limit: null } : { ok: false, status: 403, body: { error: "plan_required" } };
  }
  const limit = plan[feature];
  const n = used[feature] || 0;
  if (limit !== null && n >= limit) {
    // Past the month's allowance: score readings can still come from a 追加パック.
    if (feature === "analyze" && packSummary(doc).remaining > 0) return { ok: true, planId, used, limit, usePack: true };
    return { ok: false, status: 429, body: { error: "limit_reached", feature, limit, resetsOn: nextResetLabel(), packAvailable: feature === "analyze" } };
  }
  return { ok: true, planId, used, limit };
}
