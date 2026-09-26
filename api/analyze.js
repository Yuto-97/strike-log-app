// Vercel serverless function: POST /api/analyze
// Body: { base64, mediaType, prompt } for a single image, OR
//       { images: [{base64, mediaType}, ...], prompt } for multiple images, OR
//       { report: { notScore, needsFix, autoCorrected, manualEdit } } — the app
//       reporting how an analysis turned out (no AI call, just recorded).
// Every AI call is recorded per user (count, tokens, actual cost) — see _usage.js.
// This is the ONLY place the Anthropic API key is used — it lives in the
// server environment variable ANTHROPIC_API_KEY and is never sent to the
// browser, unlike the key-in-the-frontend approach which would let anyone
// steal and reuse it.

import { identifyCaller, recordAiCall, recordOutcome } from "./_usage.js";

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
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server" });
    return;
  }

  const { base64, mediaType, images, prompt } = req.body || {};
  const imageList = Array.isArray(images) && images.length ? images : base64 && mediaType ? [{ base64, mediaType }] : null;
  if (!imageList || !prompt) {
    res.status(400).json({ error: "prompt and either base64+mediaType or images[] are required" });
    return;
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
        max_tokens: 8000,
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
    await record(req, { ok: response.ok, usage: data?.usage });
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "Anthropic API error", raw: data });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    await record(req, { ok: false, usage: null });
    res.status(502).json({ error: `Upstream request failed: ${err.message || err}` });
  }
}

async function record(req, { ok, usage }) {
  const deps = await usageDeps();
  if (!deps) return;
  const caller = await identifyCaller(req, deps.adminAuth).catch(() => null);
  await recordAiCall({ db: deps.db, FieldValue: deps.FieldValue, caller, feature: "analyze", model: MODEL, usage, ok });
}
