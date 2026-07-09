// Vercel serverless function: POST /api/analyze
// Body: { base64: string, mediaType: string, prompt: string }
// This is the ONLY place the Anthropic API key is used — it lives in the
// server environment variable ANTHROPIC_API_KEY and is never sent to the
// browser, unlike the key-in-the-frontend approach which would let anyone
// steal and reuse it.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server" });
    return;
  }

  const { base64, mediaType, prompt } = req.body || {};
  if (!base64 || !mediaType || !prompt) {
    res.status(400).json({ error: "base64, mediaType, and prompt are all required" });
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
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "Anthropic API error", raw: data });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Upstream request failed: ${err.message || err}` });
  }
}
