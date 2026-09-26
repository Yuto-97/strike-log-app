// Usage & cost recording for the AI features (score analysis, support chat).
//
// Every AI call records who made it, what it was, and what it actually cost
// — computed from the token counts Anthropic returns with each response, so
// it's the real cost, not an estimate. Recorded per user per month.
//
// Firestore layout (all months are Japan time, "YYYY-MM"):
//   usageMonths/{month}                  totals for the whole month
//   usageMonths/{month}/users/{userKey}  one user's totals that month
//   usageUsers/{userKey}                 lastUsedAt (for "who stopped using it")
// userKey is the account uid for account holders, or the device id for
// device-only users — the same ids used by accessRequests, so the admin
// screen can show each person's name and number.
//
// Recording must never slow down or break a user's analysis: every write is
// capped by a short timeout and any failure is swallowed.
import { verifyCaller } from "./_accountAuth.js";

// USD per million tokens. Update here if Anthropic changes prices or the
// app switches models. (Sonnet 4.6: $3 input / $15 output, as of 2026.)
export const MODEL_PRICES = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};
const FALLBACK_PRICE = MODEL_PRICES["claude-sonnet-4-6"];
const RECORD_TIMEOUT_MS = 1500;

export function monthJST(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export function costUsd(model, usage) {
  const p = MODEL_PRICES[model] || FALLBACK_PRICE;
  const u = usage || {};
  return (
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.cache_read_input_tokens || 0) * p.cacheRead) /
    1_000_000
  );
}

// Who is calling: a verified account if the request carries a login token,
// otherwise the device id the app sends. Returns null if unidentifiable.
export async function identifyCaller(req, adminAuth) {
  if (adminAuth && (req.headers.authorization || req.headers.Authorization)) {
    const caller = await verifyCaller(req, adminAuth);
    if (caller) return { key: caller.uid, kind: "account" };
  }
  const deviceId = req.headers["x-device-id"];
  if (typeof deviceId === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) {
    return { key: deviceId, kind: "device" };
  }
  return null;
}

function withTimeout(promise) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, RECORD_TIMEOUT_MS))]);
}

async function write(db, FieldValue, userKey, fields, nowDate) {
  const month = monthJST(nowDate);
  const nowIso = nowDate.toISOString();
  const inc = {};
  for (const [k, v] of Object.entries(fields)) if (v) inc[k] = FieldValue.increment(v);
  if (!Object.keys(inc).length) return;
  const monthRef = db.collection("usageMonths").doc(month);
  const batch = db.batch();
  batch.set(monthRef, { ...inc, updatedAt: nowIso }, { merge: true });
  if (userKey) {
    batch.set(monthRef.collection("users").doc(userKey), { ...inc, lastUsedAt: nowIso }, { merge: true });
    batch.set(db.collection("usageUsers").doc(userKey), { lastUsedAt: nowIso }, { merge: true });
  }
  await batch.commit();
}

// One AI call. feature: "analyze" | "chat". ok=false for failed calls.
export async function recordAiCall({ db, FieldValue, caller, feature, model, usage, ok, now = new Date() }) {
  try {
    const cost = ok ? costUsd(model, usage) : 0;
    await withTimeout(
      write(
        db,
        FieldValue,
        caller?.key || null,
        {
          [feature === "chat" ? "chatCount" : "analyzeCount"]: 1,
          failCount: ok ? 0 : 1,
          inputTokens: (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0),
          outputTokens: usage?.output_tokens || 0,
          costUsd: cost,
          unidentifiedCount: caller ? 0 : 1,
        },
        now
      )
    );
  } catch (e) {
    console.warn("usage record failed", e);
  }
}

// What happened after an analysis, as seen by the app:
//   notScore: the photo wasn't a score · needsFix: the "please check" warning
//   autoCorrected: fixed automatically · manualEdit: games the user corrected
const OUTCOME_FIELDS = { notScore: "notScoreCount", needsFix: "needsFixCount", autoCorrected: "autoCorrectedCount", manualEdit: "manualEditCount" };

export async function recordOutcome({ db, FieldValue, caller, outcome, now = new Date() }) {
  try {
    const fields = {};
    for (const [k, field] of Object.entries(OUTCOME_FIELDS)) {
      const n = Number(outcome?.[k]);
      if (Number.isFinite(n) && n > 0) fields[field] = Math.min(n, 20);
    }
    await withTimeout(write(db, FieldValue, caller?.key || null, fields, now));
  } catch (e) {
    console.warn("outcome record failed", e);
  }
}
