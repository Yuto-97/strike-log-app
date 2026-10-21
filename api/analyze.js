// Vercel serverless function: POST /api/analyze
// Body: { base64, mediaType, prompt } for a single image, OR
//       { images: [{base64, mediaType}, ...], prompt } for multiple images, OR
//       { report: { notScore, needsFix, autoCorrected, manualEdit } } — the app
//       reporting how an analysis turned out (no AI call, just recorded).
// Optional purpose: "locate" — the プレミアム auto row-finding step (finds the
// player's row on the full photo before the real analysis). It needs a plan
// that includes it and never counts toward the monthly limit.
// Before every AI call the caller's plan limit is checked (see _plans.js);
// over the limit → 429 { error: "limit_reached" } and no AI call is made.
// Every AI call is recorded per user (count, tokens, actual cost) — see _usage.js.
// This is the ONLY place the Anthropic API key is used — it lives in the
// server environment variable ANTHROPIC_API_KEY and is never sent to the
// browser, unlike the key-in-the-frontend approach which would let anyone
// steal and reuse it.

import { identifyCaller, recordAiCall, recordOutcome, classifyAiError, publicAiError, noteServiceAlert } from "./_usage.js";
import { checkAllowance } from "./_plans.js";

const MODEL = "claude-sonnet-4-6";

// Loaded lazily and defensively: if Firebase is ever misconfigured, usage
// recording is skipped but score analysis itself keeps working.
async function usageDeps() {
  try {
    const { db, adminAuth, FieldValue } = await import("./_firebaseAdmin.js");
    return { db, adminAuth, FieldValue };
  } catch (e) {
    console.warn("usage recording unavailable", e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  if (req.body && req.body.report) {
    const deps = await usageDeps();
    if (deps) {
      const caller = await identifyCaller(req, deps.adminAuth).catch(() => null);
      await recordOutcome({ db: deps.db, FieldValue: deps.FieldValue, caller, outcome: req.body.report });
    }
    res.status(200).json({ ok: true });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not configured on the server");
    res.status(503).json({ error: "service_paused" });
    return;
  }

  const { base64, mediaType, images, prompt, purpose } = req.body || {};
  const feature = purpose === "locate" ? "locate" : "analyze";
  const imageList = Array.isArray(images) && images.length ? images : base64 && mediaType ? [{ base64, mediaType }] : null;
  if (!imageList || !prompt) {
    res.status(400).json({ error: "prompt and either base64+mediaType or images[] are required" });
    return;
  }

  // Plan check. If Firebase itself is unreachable we let the analysis
  // through rather than block everyone (limits are a fairness rule, not
  // a security boundary).
  const deps = await usageDeps();
  let caller = null;
  let allowance = null;
  if (deps) {
    caller = await identifyCaller(req, deps.adminAuth).catch(() => null);
    try {
      allowance = await checkAllowance({ db: deps.db, caller, feature });
    } catch (e) {
      console.warn("plan check failed", e.message || e);
    }
    if (allowance && !allowance.ok) {
      res.status(allowance.status).json(allowance.body);
      return;
    }
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: feature === "locate" ? 600 : 8000,
        messages: [
          {
            role: "user",
            content: [
              ...imageList.map((img) => ({
                type: "image",
                source: { type: "base64", media_type: img.mediaType, data: img.base64 },
              })),
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    await record(deps, caller, feature, { ok: response.ok, usage: data?.usage });
    if (!response.ok) {
      // Details stay in the server log; the app only gets a category it can
      // turn into a friendly Japanese message.
      const kind = classifyAiError(response.status, data);
      console.error(`Anthropic API error (${response.status}, ${kind}):`, JSON.stringify(data).slice(0, 500));
      if (deps) await noteServiceAlert({ db: deps.db, FieldValue: deps.FieldValue, kind, message: data?.error?.message });
      const pub = publicAiError(kind);
      res.status(pub.status).json(pub.body);
      return;
    }

    res.status(200).json(withUsage(data, feature, allowance));
  } catch (err) {
    await record(deps, caller, feature, { ok: false, usage: null });
    console.error("Upstream request failed:", err.message || err);
    res.status(502).json({ error: "network" });
  }
}

async function record(deps, caller, feature, { ok, usage }) {
  if (!deps) return;
  await recordAiCall({ db: deps.db, FieldValue: deps.FieldValue, caller, feature, model: MODEL, usage, ok });
}

// Tells the app this month's count after a successful analysis, so it can
// show "今月 12/60回" without asking again.
function withUsage(data, feature, allowance) {
  if (feature !== "analyze" || !allowance || !allowance.used) return data;
  return { ...data, _usage: { feature, used: (allowance.used.analyze || 0) + 1, limit: allowance.limit } };
}
