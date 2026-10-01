// Cloudflare Pages Function: GET /api/live
// Pulls the newest episodes from the show's podcast feed and the NFC North
// records from ESPN, so dahcp.com stays current without manual uploads.
// The page falls back to the data saved inside index.html if this fails.

const FEED_URL = "https://feeds.buzzsprout.com/2299439.rss";
const ESPN_TEAM = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/";
const TEAMS = [
  { code: "DET", espn: "det", name: "Lions" },
  { code: "GB", espn: "gb", name: "Packers" },
  { code: "CHI", espn: "chi", name: "Bears" },
  { code: "MIN", espn: "min", name: "Vikings" },
];
const CACHE_SECONDS = 600; // refresh at most every 10 minutes
const UA = { "user-agent": "dahcp.com site (+https://dahcp.com)" };

export async function onRequestGet(context) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/live?cache=v1", context.request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const [eps, recs] = await Promise.allSettled([getEpisodes(), getRecords()]);
  const body = { generatedAt: new Date().toISOString() };
  if (eps.status === "fulfilled" && eps.value.length) body.episodes = eps.value;
  else body.episodesError = String(eps.reason || "no episodes found");
  if (recs.status === "fulfilled") body.records = recs.value;
  else body.recordsError = String(recs.reason || "no records found");

  const ok = body.episodes || body.records;
  const res = new Response(JSON.stringify(body), {
    status: ok ? 200 : 502,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ok ? `public, max-age=60, s-maxage=${CACHE_SECONDS}` : "no-store",
    },
  });
  if (ok && cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ---------- episodes (podcast RSS feed) ---------- */

async function getEpisodes() {
  const r = await fetch(FEED_URL, { headers: UA, cf: { cacheTtl: CACHE_SECONDS } });
  if (!r.ok) throw new Error("feed HTTP " + r.status);
  const xml = await r.text();
  const chunks = xml.split(/<item[\s>]/i).slice(1).map(c => c.split(/<\/item>/i)[0]);
  const total = chunks.length;
  const out = chunks.map((c, i) => {
    const rawTitle = tag(c, "title");
    const m = rawTitle.match(/\bEP\.?\s*#?\s*(\d+)/i);
    const number = m ? parseInt(m[1], 10) : null;
    const title = rawTitle.replace(/\s*[|\-–—:]\s*EP\.?\s*#?\s*\d+\s*$/i, "").trim() || rawTitle;
    const pub = new Date(tag(c, "pubDate"));
    const date = isNaN(pub) ? "" : pub.toISOString().slice(0, 10);
    let url = tag(c, "link");
    if (!/^https?:\/\//i.test(url)) url = "https://honolulucheese.buzzsprout.com/";
    return { number, title, date, url };
  }).filter(e => e.title && e.date);
  // Titles normally end in "EP. 123"; if one doesn't, number it from its neighbours.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].number == null) out[i].number = i + 1 < out.length && out[i + 1].number != null ? out[i + 1].number + 1 : total - i;
  }
  out.sort((a, b) => b.number - a.number || b.date.localeCompare(a.date));
  return out.slice(0, 12);
}

function tag(s, name) {
  const m = s.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cd = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cd) return cd[1].trim();
  return decode(v);
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/* ---------- records (ESPN team schedules) ---------- */

async function getRecords() {
  const teams = await Promise.all(TEAMS.map(getTeam));
  const weeks = teams.map(t => t.lastWeek).filter(Boolean);
  const season = teams.map(t => t.season).find(Boolean) || new Date().getFullYear();
  return {
    season,
    updatedAfter: weeks.length ? "Week " + Math.max(...weeks) : "Preseason",
    updatedOn: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    teams: teams.map(({ code, name, w, l, t, recent }) => ({ code, name, w, l, t, recent })),
  };
}

async function getTeam(team) {
  const r = await fetch(ESPN_TEAM + team.espn + "/schedule", { headers: UA, cf: { cacheTtl: CACHE_SECONDS } });
  if (!r.ok) throw new Error(team.code + " schedule HTTP " + r.status);
  const j = await r.json();
  const myId = String((j.team && j.team.id) || "");
  if (!myId) throw new Error(team.code + ": no team id");

  const games = (j.events || [])
    .filter(e => seasonType(e) === 2)
    .map(e => ({ e, c: (e.competitions || [])[0] }))
    .filter(({ c }) => c && c.status && c.status.type && c.status.type.completed)
    .sort((a, b) => new Date(a.e.date) - new Date(b.e.date));

  let w = 0, l = 0, t = 0, lastWeek = 0;
  const recent = [];
  for (const { e, c } of games) {
    const me = (c.competitors || []).find(x => String(x.id || (x.team && x.team.id)) === myId);
    const opp = (c.competitors || []).find(x => x !== me);
    if (!me || !opp) continue;
    let res;
    if (me.winner === true) res = "W";
    else if (opp.winner === true) res = "L";
    else {
      const a = score(me), b = score(opp);
      res = a > b ? "W" : a < b ? "L" : "T";
    }
    if (res === "W") w++; else if (res === "L") l++; else t++;
    recent.push(res);
    if (e.week && e.week.number) lastWeek = Math.max(lastWeek, e.week.number);
  }

  // Prefer ESPN's own record summary for the totals when it's present.
  const summary = j.team && (j.team.recordSummary || "");
  const sm = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(summary.trim());
  if (sm) { w = +sm[1]; l = +sm[2]; t = +(sm[3] || 0); }

  const season = (j.requestedSeason && j.requestedSeason.year) || (j.season && j.season.year) || null;
  return { code: team.code, name: team.name, w, l, t, recent, lastWeek, season };
}

function seasonType(e) {
  const st = e.seasonType || (e.season && e.season.type);
  if (st && typeof st === "object") return Number(st.type || st.id);
  return Number(st || 2);
}

function score(x) {
  const s = x.score;
  if (s == null) return 0;
  if (typeof s === "object") return Number(s.value != null ? s.value : s.displayValue) || 0;
  return Number(s) || 0;
}
