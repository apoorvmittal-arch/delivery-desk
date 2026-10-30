// Gives the page the public Supabase settings. Never put secret keys here.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    emailLinks: process.env.EMAIL_LINKS === "on"
  });
};
