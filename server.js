// High Society DM Bot - live demo server. No packages needed: plain Node 18+.
// Settings come from Render "Environment" variables:
//   ANTHROPIC_API_KEY  (required)  your Claude API key
//   DEMO_PIN           (optional)  a code people must type to use the demo
//   DAILY_LIMIT        (optional)  max AI replies per day, default 400
//   MODEL              (optional)  default claude-sonnet-5-5
const http = require("http");
const fs = require("fs");
const path = require("path");
const K = require("./knowledge");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_URL = process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const PIN = (process.env.DEMO_PIN || "").trim();
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 400;
const PORT = process.env.PORT || 3000;
const MAX_TURNS_PER_CHAT = 40;

/* ---------- dates in Cebu time ---------- */
const DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function cebuNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { today: new Date(Date.UTC(+p.year, +p.month - 1, +p.day)), hour: +p.hour, min: +p.minute, year: p.year };
}
const addD = (d, n) => new Date(d.getTime() + n * 864e5);
const iso = d => d.toISOString().slice(0, 10);
const fromIso = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const nice = d => `${DN[d.getUTCDay()]} ${d.getUTCDate()} ${MN[d.getUTCMonth()]}`;
const isOpen = d => [0, 4, 5, 6].includes(d.getUTCDay());
const rate = (d, key) => K.PRICES[key][d.getUTCDay() === 4 ? 1 : 0];
const peso = n => "₱" + Number(n).toLocaleString("en-US");
function clock() { const { hour, min } = cebuNow(); return `${((hour + 11) % 12) + 1}:${String(min).padStart(2, "0")}${hour < 12 ? "AM" : "PM"}`; }
function respLine() { const { today, hour } = cebuNow(); return (hour >= 21 && isOpen(today)) || (hour < 4 && isOpen(addD(today, -1))) ? "as soon as we can" : "shortly"; }
function nextDow(w) { const { today } = cebuNow(); for (let i = 0; i < 8; i++) { const d = addD(today, i); if (d.getUTCDay() === w) return d; } }

/* ---------- demo state (in memory; resets when the server restarts) ---------- */
const ACTIVE = ["Pending", "Deposit sent", "Confirmed"];
let S;
function fresh() {
  const sat = nextDow(6), fri = nextDow(5);
  return {
    seq: 1000, hseq: 100, chatSeq: 0, chats: {},
    book: [
      { id: "HS-0991", date: iso(sat), time: "10:30PM", table: "C", key: "Al Capone VVIP", pax: 14, name: "Mark R.", contact: "0917 xxx xxxx", gl: "", req: "", status: "Confirmed", by: "Joy", demo: 1 },
      { id: "HS-0992", date: iso(sat), time: "11:00PM", table: "A", key: "Pablo Escobar VIP", pax: 9, name: "Kaye L.", contact: "0998 xxx xxxx", gl: "DJ Kokas", req: "", status: "Deposit sent", by: "", demo: 1 },
      { id: "HS-0993", date: iso(sat), time: "10:00PM", table: "10+11", key: "Square pair", pax: 6, name: "Jho M.", contact: "0927 xxx xxxx", gl: "", req: "", status: "Pending", by: "", demo: 1 },
      { id: "HS-0994", date: iso(fri), time: "10:00PM", table: "13+14", key: "Square pair", pax: 7, name: "Ryan T.", contact: "0939 xxx xxxx", gl: "", req: "", status: "Confirmed", by: "Joy", demo: 1 },
    ],
    hand: [],
  };
}
S = fresh();
const taken = (date, id) => S.book.some(b => b.date === date && b.table === id && ACTIVE.includes(b.status));
function getChat(id) {
  id = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (!id) return null;
  if (!S.chats[id]) S.chats[id] = { id, name: "Guest " + (++S.chatSeq), msgs: [], api: [], bot: true, turns: 0, busy: false, at: Date.now() };
  return S.chats[id];
}
function push(chat, m) { chat.msgs.push(m); chat.at = Date.now(); }

/* ---------- the bot's tools ---------- */
function checkAvailability(_, { date, pax }) {
  const { today } = cebuNow();
  const d = fromIso(date); pax = Math.max(1, Math.round(+pax || 0));
  if (!d) return { error: "Date must be YYYY-MM-DD." };
  if (d < today) return { error: "That date has passed." };
  if (!isOpen(d)) return { open: false, date, day: DN[d.getUTCDay()], note: "Closed Monday to Wednesday. Open Thursday to Sunday." };
  const opts = Object.keys(K.PRICES).map(key => {
    const ts = K.TABLES.filter(t => t.key === key), free = ts.filter(t => !taken(date, t.id));
    const t = ts[0], r = rate(d, key), extra = Math.max(0, pax - t.inc);
    return { price_key: key, table_type: K.LABEL[key], seated: K.SEATED.includes(key), free_count: free.length, included_people: t.inc,
      max_people: t.max >= K.NO_LIMIT ? "no limit" : t.max, fits: pax <= t.max, rate: r, extra_people: extra, extra_fee: extra * K.EXTRA_FEE, total_before_service: r + extra * K.EXTRA_FEE };
  }).filter(o => o.fits && o.free_count > 0);
  const noExtra = opts.filter(o => o.seated && o.extra_people === 0).sort((a, b) => a.rate - b.rate)[0];
  const anySeated = opts.filter(o => o.seated).sort((a, b) => a.total_before_service - b.total_before_service)[0];
  const standing = opts.filter(o => !o.seated)[0];
  const sold = Object.keys(K.PRICES).filter(k => K.TABLES.filter(t => t.key === k).every(t => taken(date, t.id))).map(k => K.LABEL[k]);
  return { open: true, date, day: DN[d.getUTCDay()], rate_type: d.getUTCDay() === 4 ? "Thursday rate" : "weekend rate", pax,
    best_seated_fit: noExtra || anySeated || null,
    cheaper_seated_with_extras: anySeated && noExtra && anySeated.total_before_service < noExtra.rate ? anySeated : null,
    standing_option: standing || null, fully_booked_types: sold,
    note: "Rates are consumable, plus 10% service charge. Extra people are paid at the venue." };
}
function createBooking(chat, a) {
  const d = fromIso(a.date); if (!d || !isOpen(d)) return { error: "Not an open night." };
  const key = Object.keys(K.PRICES).find(k => k === a.price_key) || Object.keys(K.PRICES).find(k => K.LABEL[k] === a.price_key);
  if (!key) return { error: "Unknown price_key. Use one from check_availability." };
  const t = K.TABLES.find(t => t.key === key && !taken(a.date, t.id)); if (!t) return { error: "No free table of that type on that date." };
  const pax = Math.round(+a.pax || 0); if (pax < 1 || pax > t.max) return { error: "Number of people does not fit this table type." };
  const b = { id: "HS-" + (++S.seq), date: a.date, time: String(a.arrival_time || "").slice(0, 20), table: t.id, key, pax,
    name: String(a.guest_name || "").slice(0, 60), contact: String(a.contact || "").slice(0, 40), gl: String(a.guest_list || "").slice(0, 60),
    req: String(a.special_request || "").slice(0, 200), status: "Pending", by: "", chat: chat.id };
  S.book.push(b);
  const r = rate(d, key), extra = Math.max(0, pax - t.inc);
  return { booking_id: b.id, status: "Pending", table_type: K.LABEL[key], table_id: t.id, rate: r, deposit: r * K.DEPOSIT, extra_people: extra, extra_fee_paid_at_venue: extra * K.EXTRA_FEE };
}
function sendQR(chat, { booking_id }) {
  const b = S.book.find(x => x.id === booking_id); if (!b) return { error: "Unknown booking_id." };
  const amt = rate(fromIso(b.date), b.key) * K.DEPOSIT; b.status = "Deposit sent";
  push(chat, { k: "qr", amt, id: b.id }); return { sent: true, deposit: amt, booking_id };
}
function logHandover(chat, { reason, summary, booking_id }) {
  const h = { id: "H-" + (++S.hseq), at: clock(), reason: String(reason || "Other").slice(0, 60), summary: String(summary || "").slice(0, 600),
    bid: booking_id || "", prio: /complain|safety/i.test(reason || ""), status: "Open", chat: chat.id, reply: "" };
  S.hand.push(h); chat.handedOver = true;
  return { logged: true, handover_id: h.id, tell_guest: `The team will follow up ${respLine()}.` };
}
function recordProof(chat, { booking_id }) {
  const b = S.book.find(x => x.id === booking_id) || S.book.filter(x => x.chat === chat.id).slice(-1)[0];
  return logHandover(chat, { reason: "Payment proof to check", booking_id: b ? b.id : "",
    summary: b ? `Guest sent the deposit screenshot for ${b.id}: ${nice(fromIso(b.date))}, ${b.pax} pax, ${K.LABEL[b.key]} (${b.table}), deposit ${peso(rate(fromIso(b.date), b.key) * K.DEPOSIT)}.` : "Guest sent a payment screenshot." });
}
const TOOLS = [
  { name: "check_availability", run: checkAvailability, description: "Check open status, free table types and exact prices for a date and group size. Call before quoting any price for a specific night.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, pax: { type: "integer" } }, required: ["date", "pax"] } },
  { name: "create_booking", run: createBooking, description: "Create a Pending booking after you have date, pax, table type, name, contact and arrival time.",
    input_schema: { type: "object", properties: { date: { type: "string" }, pax: { type: "integer" }, price_key: { type: "string", description: "price_key from check_availability" }, guest_name: { type: "string" }, contact: { type: "string" }, arrival_time: { type: "string" }, guest_list: { type: "string", description: "whose guest list, or empty" }, special_request: { type: "string" } }, required: ["date", "pax", "price_key", "guest_name", "contact"] } },
  { name: "send_deposit_qr", run: sendQR, description: "Send the InstaPay deposit QR (50% of the table rate) into the chat. Call right after create_booking.",
    input_schema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] } },
  { name: "record_payment_proof", run: recordProof, description: "The guest sent a payment screenshot. Logs it for staff to check. This hands the chat to staff.",
    input_schema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] } },
  { name: "log_handover", run: logHandover, description: "Pass the chat to staff. reason is one of: Special request, Private event / buyout, Exception, Discount / free entry, Complaint, Safety, Payment problem, Refund / cancellation, Lost and found, Question not approved yet, Asked for a person.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, summary: { type: "string" }, booking_id: { type: "string" } }, required: ["reason", "summary"] } },
];
const TOOL_DEFS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

/* ---------- talking to Claude ---------- */
const SYSTEM_BASE = `You are the High Society Club Cebu Instagram DM assistant. Follow these notes exactly. If something is not in the notes, do not guess: hand over.\n\n${K.KB}\n\nOUTPUT: write only the message text the guest will see. To send two separate messages, put a line with only --- between them.`;
function nowBlock(chat) {
  const { today, year } = cebuNow();
  const days = []; for (let i = 0; i < 14; i++) { const d = addD(today, i); days.push(`${nice(d)} = ${iso(d)}${isOpen(d) ? "" : " (closed)"}${i === 0 ? " (today)" : ""}`); }
  const mine = S.book.filter(b => b.chat === chat.id);
  return `NOW\nCurrent time in Cebu: ${clock()}, ${nice(today)} ${year}. Response time line to use: "${respLine()}".\nNext 14 days: ${days.join("; ")}.\nThis guest's bookings: ${mine.length ? mine.map(b => `${b.id} ${b.date} ${K.LABEL[b.key]} ${b.pax} pax, ${b.status}`).join("; ") : "none"}.`;
}
async function callClaude(chat) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, tools: TOOL_DEFS, messages: chat.api,
      system: [{ type: "text", text: SYSTEM_BASE, cache_control: { type: "ephemeral" } }, { type: "text", text: nowBlock(chat) }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || "HTTP " + res.status); e.status = res.status; throw e; }
  return data;
}
let day = "", dayCount = 0;
async function botTurn(chat, userText) {
  const d = iso(cebuNow().today); if (d !== day) { day = d; dayCount = 0; }
  if (dayCount >= DAILY_LIMIT) { push(chat, { k: "note", t: "The demo has reached today's message limit. Try again tomorrow." }); return; }
  if (chat.turns >= MAX_TURNS_PER_CHAT) { push(chat, { k: "note", t: "This chat is full. Start a new guest chat to keep testing." }); return; }
  dayCount++; chat.turns++;
  const mark = chat.api.length;
  chat.api.push({ role: "user", content: userText });
  try {
    let out;
    for (let i = 0; i < 6; i++) {
      out = await callClaude(chat);
      chat.api.push({ role: "assistant", content: out.content });
      if (out.stop_reason !== "tool_use") break;
      const results = [];
      for (const blk of out.content.filter(c => c.type === "tool_use")) {
        const tool = TOOLS.find(t => t.name === blk.name);
        let r; try { r = tool ? tool.run(chat, blk.input || {}) : { error: "Unknown tool" }; } catch (e) { r = { error: String(e.message || e) }; }
        results.push({ type: "tool_result", tool_use_id: blk.id, content: JSON.stringify(r) });
      }
      chat.api.push({ role: "user", content: results });
    }
    const text = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    if (out.stop_reason === "tool_use") {
      // too many tool steps: drop this turn from the AI's history so the chat can continue cleanly
      chat.api.length = mark;
      push(chat, { k: "note", t: "The bot got stuck on that one. Try rephrasing." });
      return;
    }
    text.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean).forEach(t => push(chat, { k: "bot", t }));
    if (chat.handedOver) { chat.bot = false; push(chat, { k: "note", t: "Passed to staff. The bot stops replying in this chat (see Handovers)." }); }
  } catch (e) {
    chat.api.length = mark; chat.turns--;
    console.error("Claude error:", e.status || "", e.message);
    push(chat, { k: "note", t: e.status === 429 ? "The AI is busy. Wait a few seconds and try again." : !API_KEY ? "The server has no ANTHROPIC_API_KEY set." : "The bot couldn't reply just now. Try again." });
  }
}

/* ---------- staff actions ---------- */
function confirmBooking(id) {
  const b = S.book.find(x => x.id === id); if (!b || !ACTIVE.includes(b.status)) return "Booking not found";
  if (!S.hand.some(h => h.bid === b.id && /proof/i.test(h.reason))) return "Waiting for payment proof";
  b.status = "Confirmed"; b.by = "Staff (demo)";
  S.hand.filter(h => h.bid === b.id).forEach(h => h.status = "Done");
  const chat = S.chats[b.chat];
  if (chat) {
    chat.bot = false;
    push(chat, { k: "staff", t: `Confirmed ✅\n${b.name}, you're booked for ${nice(fromIso(b.date))}: ${K.LABEL[b.key]} (${b.table}), ${b.pax} pax${b.time ? `, arriving ${b.time}` : ""}.\nWe hold your table for 15 minutes after that. Kita-kits! 🥂` });
    push(chat, { k: "note", t: "Staff confirmed the booking. The bot stays silent here from now on." });
  }
  return "";
}
function staffReply(hid, text) {
  const h = S.hand.find(x => x.id === hid); if (!h) return "Handover not found";
  h.reply = text; h.status = "In progress";
  const chat = S.chats[h.chat];
  if (chat) { chat.bot = false; push(chat, { k: "staff", t: text }); push(chat, { k: "note", t: "Staff has taken over this chat. The bot stays silent here from now on." }); }
  return "";
}

/* ---------- web server ---------- */
const hits = new Map();
function limited(ip) { const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 600000); arr.push(now); hits.set(ip, arr); return arr.length > 40; }
function publicState(chatId) {
  const chats = Object.values(S.chats).sort((a, b) => b.at - a.at).slice(0, 30).map(c => ({ id: c.id, name: c.name, bot: c.bot, n: c.msgs.length }));
  const c = S.chats[chatId];
  return { chats, chat: c ? { id: c.id, name: c.name, bot: c.bot, busy: c.busy, msgs: c.msgs } : null,
    book: S.book.map(({ chat, ...b }) => ({ ...b, mine: !!chatId && chat === chatId })), hand: S.hand, today: iso(cebuNow().today) };
}
function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise(ok => { let s = ""; req.on("data", c => { s += c; if (s.length > 10000) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); }); }
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p.startsWith("/api/")) {
      if (p === "/api/config") return send(res, 200, { pin: !!PIN, model: MODEL, prices: K.PRICES, label: K.LABEL, short: K.SHORT, tables: K.TABLES, kb: K.KB, changes: K.CHANGES, extraFee: K.EXTRA_FEE, deposit: K.DEPOSIT });
      if (PIN && req.headers["x-demo-pin"] !== PIN) return send(res, 401, { error: "PIN needed" });
      if (req.method === "GET" && p === "/api/state") return send(res, 200, publicState(url.searchParams.get("chat")));
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const b = await body(req);
      if (p === "/api/chat") {
        const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        const chat = getChat(b.chatId); if (!chat) return send(res, 400, { error: "No chat" });
        if (chat.busy) return send(res, 409, { error: "Still replying" });
        const text = String(b.text || "").trim().slice(0, 500);
        if (!text && !b.photo) return send(res, 400, { error: "Empty" });
        if (b.photo) push(chat, { k: "photo", t: b.photoLabel ? String(b.photoLabel).slice(0, 20) : "" }); else push(chat, { k: "g", t: text });
        if (!chat.bot) { push(chat, { k: "note", t: "Staff has this chat. The bot does not reply." }); return send(res, 200, publicState(chat.id)); }
        if (limited(ip)) { push(chat, { k: "note", t: "Too many messages too fast. Wait a minute." }); return send(res, 200, publicState(chat.id)); }
        chat.busy = true;
        try { await botTurn(chat, b.photo ? "[The guest sent a photo: a payment screenshot]" : text); } finally { chat.busy = false; }
        return send(res, 200, publicState(chat.id));
      }
      if (p === "/api/new-chat") { const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); getChat(id); return send(res, 200, { id }); }
      if (p === "/api/staff/confirm") { const e = confirmBooking(b.id); return send(res, e ? 400 : 200, e ? { error: e } : publicState(b.chatId)); }
      if (p === "/api/staff/cancel") { const x = S.book.find(y => y.id === b.id); if (x) x.status = "Cancelled"; return send(res, 200, publicState(b.chatId)); }
      if (p === "/api/staff/reply") { const e = staffReply(b.hid, String(b.text || "").trim().slice(0, 500)); return send(res, e ? 400 : 200, e ? { error: e } : publicState(b.chatId)); }
      if (p === "/api/staff/done") { const h = S.hand.find(x => x.id === b.hid); if (h) h.status = "Done"; return send(res, 200, publicState(b.chatId)); }
      if (p === "/api/reset") { S = fresh(); return send(res, 200, publicState("")); }
      return send(res, 404, { error: "Not found" });
    }
    const file = p === "/" ? "index.html" : p === "/privacy" ? "privacy.html" : p.slice(1);
    const fp = path.join(PUB, path.normalize(file).replace(/^(\.\.[\/\\])+/, ""));
    if (!fp.startsWith(PUB) || !fs.existsSync(fp)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: "Server error" }); }
}).listen(PORT, () => console.log(`High Society DM Bot running on port ${PORT}${API_KEY ? "" : " (WARNING: no ANTHROPIC_API_KEY)"}`));
