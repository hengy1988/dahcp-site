// Cloudflare Pages Function: POST /api/ask
// Emails each "Ask Da HCP" question to the show using Resend (resend.com).
// Settings needed in Cloudflare (Pages project > Settings > Variables and Secrets):
//   RESEND_API_KEY  - the API key from Resend (add it as a Secret)
//   ASK_TO_EMAIL    - the address that receives questions (the email used to sign up for Resend)
// Optional:
//   ASK_FROM_EMAIL  - a sender on a domain verified in Resend, e.g. "Ask Da HCP <questions@dahcp.com>"

const TYPES = ["Question for the crew", "Topic idea", "Hot take to debate", "Prediction"];
const TEAMS = ["", "Lions", "Packers", "Bears", "Vikings", "Other NFL team"];

export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch { return reply(400, "Something went wrong reading the form. Try again."); }

  // Spam checks: a hidden field people never see, and a minimum time on the page.
  if (d.website) return reply(200, "ok"); // pretend it worked for bots
  if (typeof d.started === "number" && Date.now() - d.started < 3000) return reply(200, "ok");

  const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
  const msg = clean(d.msg, 600);
  const name = clean(d.name, 60) || "A listener";
  const team = TEAMS.includes(d.team) ? d.team : "";
  const type = TYPES.includes(d.type) ? d.type : TYPES[0];
  const email = clean(d.email, 120);
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  if (msg.length < 3) return reply(400, "Write your question or topic first.");

  if (!env.RESEND_API_KEY || !env.ASK_TO_EMAIL) return reply(503, "The question inbox isn't set up yet.");

  const lines = [
    `${type} from ${name}${team ? " (" + team + " fan)" : ""}`,
    "",
    msg,
    "",
    replyTo ? `Reply to: ${replyTo}` : "No email left, so reply on the show!",
    "",
    "Sent from the Ask Da HCP form on dahcp.com",
  ];
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.ASK_FROM_EMAIL || "Ask Da HCP <onboarding@resend.dev>",
      to: [env.ASK_TO_EMAIL],
      subject: `#AskDaHCP · ${type} from ${name}`,
      text: lines.join("\n"),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!r.ok) {
    const why = await r.text().catch(() => "");
    console.log("Resend error", r.status, why);
    return reply(502, "We couldn't send that right now.");
  }
  return reply(200, "ok");
}

function reply(status, message) {
  return new Response(JSON.stringify({ ok: status === 200, message }), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
