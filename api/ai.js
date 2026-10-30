// AI drafting of scope and acceptance criteria. Keeps the Anthropic key on the server.
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST", code: "unavailable" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "AI drafting is not set up", code: "sampling_disabled" });

  // Only signed-in Delivery Desk users may use it.
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in again", code: "session_expired" });
  try {
    const who = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: "Bearer " + token }
    });
    if (!who.ok) return res.status(401).json({ error: "Sign in again", code: "session_expired" });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't check your sign-in", code: "unavailable" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
  const prompt = String((body && body.prompt) || "");
  if (!prompt) return res.status(400).json({ error: "Missing prompt", code: "unavailable" });
  if (prompt.length > 150000) return res.status(413).json({ error: "PRD too long", code: "prompt_too_large" });

  let r, j;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 2000,
        system: "Reply with one JSON object only. No prose, no Markdown fences.",
        messages: [{ role: "user", content: prompt }]
      })
    });
    j = await r.json();
  } catch (e) {
    return res.status(502).json({ error: "AI service unreachable", code: "unavailable" });
  }
  if (!r.ok) {
    const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 413 ? "prompt_too_large" : "unavailable";
    return res.status(r.status === 429 ? 429 : 502).json({ error: (j && j.error && j.error.message) || "AI request failed", code });
  }
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    const result = JSON.parse(text.slice(start, end + 1));
    return res.status(200).json({ result });
  } catch (e) {
    return res.status(502).json({ error: "AI reply wasn't valid JSON", code: "invalid_json" });
  }
};
