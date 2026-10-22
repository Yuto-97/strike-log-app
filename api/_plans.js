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
  basic: { label: "ベーシック", analyze: 60, chat: 30, premiumStats: false, autoLocate: false },
  premium: { label: "プレミアム", analyze: 150, chat: 150, premiumStats: true, autoLocate: true },
  premium_plus: { label: "プレミアム＋", analyze: null, chat: null, premiumStats: true, autoLocate: true },
  free: { label: "招待(無料)", analyze: null, chat: null, premiumStats: true, autoLocate: true },
  legacy: { label: "未設定", analyze: null, chat: null, premiumStats: true, autoLocate: false },
};

// Plans the admin can assign (legacy = "clear the setting").
export const ASSIGNABLE_PLANS = ["basic", "premium", "premium_plus", "free"];

export function plansEnabled() {
  return process.env.PLANS_ENABLED === "1";
}

export function effectivePlanId(requestDoc) {
  const p = requestDoc && requestDoc.plan;
  if (p && ASSIGNABLE_PLANS.includes(p)) return p;
  return plansEnabled() ? "basic" : "legacy";
}

export function nextResetLabel(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() === 11 ? 1 : jst.getUTCMonth() + 2}月1日`;
}

// What the app is told about a person's plan.
export function planView(planId, used) {
  const p = PLANS[planId] || PLANS.legacy;
  return {
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
  const planId = effectivePlanId(doc.exists ? doc.data() : null);
  const used = withUsage ? await loadUsed(db, key) : null;
  return { planId, used };
}

// Called before an AI request. feature: "analyze" | "chat" | "locate".
// Returns { ok: true, planId, used, limit } or { ok: false, status, body }.
export async function checkAllowance({ db, caller, feature }) {
  if (!caller) {
    return plansEnabled() ? { ok: false, status: 401, body: { error: "unidentified" } } : { ok: true, planId: "legacy", used: null, limit: null };
  }
  const { planId, used } = await loadPlanState(db, caller.key);
  const plan = PLANS[planId];
  if (feature === "recheck") return { ok: true, planId, used, limit: null };
  if (feature === "locate") {
    return plan.autoLocate ? { ok: true, planId, used, limit: null } : { ok: false, status: 403, body: { error: "plan_required" } };
  }
  const limit = plan[feature];
  const n = used[feature] || 0;
  if (limit !== null && n >= limit) {
    return { ok: false, status: 429, body: { error: "limit_reached", feature, limit, resetsOn: nextResetLabel() } };
  }
  return { ok: true, planId, used, limit };
}
