// Cloudflare Pages Function: GET /api/live
// Pulls the newest episodes from the show's podcast feed and the NFC North
// records from ESPN, so dahcp.com stays current without manual uploads.
// The page falls back to the data saved inside index.html if this fails.

const FEED_URL = "https://feeds.buzzsprout.com/2299439.rss";
const SHOW_PAGE = "https://honolulucheese.buzzsprout.com/";
const ESPN_HOSTS = [
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/",
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/",
];
const TEAMS = [
  { code: "DET", espn: "det", id: 8, name: "Lions" },
  { code: "GB", espn: "gb", id: 9, name: "Packers" },
  { code: "CHI", espn: "chi", id: 3, name: "Bears" },
  { code: "MIN", espn: "min", id: 16, name: "Vikings" },
];
const CACHE_SECONDS = 600; // refresh at most every 10 minutes
const UA = { "user-agent": "dahcp.com site (+https://dahcp.com)" };
const BROWSER = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "accept": "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://www.espn.com/",
};
const LAST_GOOD = "/api/live?cache=last-good-records";

export async function onRequestGet(context) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/live?cache=v2", context.request.url).toString());
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
    // Each episode's own page: https://honolulucheese.buzzsprout.com/2299439/episodes/<id>
    const encl = (c.match(/<enclosure[^>]*url="([^"]+)"/i) || [])[1] || "";
    const ids = (tag(c, "guid") + " " + encl + " " + tag(c, "link")).match(/\d{6,}/g) || [];
    const epId = ids.find(x => x !== "2299439");
    let url = epId ? SHOW_PAGE + "2299439/episodes/" + epId : tag(c, "link");
    if (!/^https?:\/\//i.test(url)) url = SHOW_PAGE;
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
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://dahcp.com" + LAST_GOOD);
  try {
    const fresh = await getRecordsFresh();
    if (cache) await cache.put(key, new Response(JSON.stringify(fresh), {
      headers: { "content-type": "application/json", "cache-control": "public, s-maxage=2592000" },
    }));
    return fresh;
  } catch (err) {
    // ESPN refused or changed: fall back to the last records that loaded fine.
    const old = cache && await cache.match(key);
    if (old) return await old.json();
    throw err;
  }
}

async function getRecordsFresh() {
  try { return await getRecordsEspn(); }
  catch (espnErr) {
    try { return await getRecordsSportsDb(); }
    catch (dbErr) { throw new Error(espnErr.message + " / backup: " + dbErr.message); }
  }
}

// Backup source: TheSportsDB league table (NFL league id 4391).
async function getRecordsSportsDb() {
  const year = new Date().getFullYear();
  for (const season of [String(year), String(year - 1)]) {
    const r = await fetch("https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=4391&s=" + season, { headers: BROWSER, cf: { cacheTtl: CACHE_SECONDS } });
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    const rows = (j && j.table) || [];
    const full = { DET: "Detroit Lions", GB: "Green Bay Packers", CHI: "Chicago Bears", MIN: "Minnesota Vikings" };
    const teams = TEAMS.map(t => {
      const row = rows.find(x => (x.strTeam || "").toLowerCase() === full[t.code].toLowerCase());
      if (!row) return null;
      const w = parseInt(row.intWin, 10), l = parseInt(row.intLoss, 10), d = parseInt(row.intDraw || "0", 10);
      if (![w, l, d].every(Number.isFinite)) return null;
      return { code: t.code, name: t.name, w, l, t: d, recent: [] };
    });
    if (teams.every(Boolean) && teams.some(t => t.w + t.l + t.t > 0)) {
      return {
        season: parseInt(season, 10),
        updatedAfter: "the latest games",
        updatedOn: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
        teams,
      };
    }
  }
  throw new Error("TheSportsDB had no usable table");
}

async function getRecordsEspn() {
  const teams = [];
  for (const t of TEAMS) teams.push(await getTeam(t)); // one at a time, gentler on ESPN
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
  let j = null, lastErr = "";
  outer: for (const host of ESPN_HOSTS) {
    for (const slug of [team.espn, team.id]) {
      try {
        const r = await fetch(host + slug + "/schedule", { headers: BROWSER, cf: { cacheTtl: CACHE_SECONDS } });
        if (!r.ok) { lastErr = "HTTP " + r.status; continue; }
        j = await r.json();
        if (j && j.team) break outer;
      } catch (e) { lastErr = String(e); }
    }
  }
  if (!j || !j.team) throw new Error(team.code + " schedule " + lastErr);
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
