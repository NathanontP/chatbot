// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

/* ----------------------- Config ----------------------- */
const CHAT_MODEL = process.env.CHAT_MODEL || "openai/gpt-4o-mini";
const KB_PATH = process.env.KB_PATH || path.join(__dirname, "kb", "restaurant.md");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/* ----------------------- Static files (images) ----------------------- */
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "image");
const STATIC_BASE_URL = process.env.STATIC_BASE_URL || `http://localhost:${PORT}`;
app.use("/static", express.static(STATIC_DIR, { maxAge: "30d", immutable: true }));

/* ---- helper: mime detect by extension / magic bytes (รองรับไฟล์ไร้นามสกุล) ---- */
function mimeFromExt(ext) {
  switch (ext) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png":  return "image/png";
    case ".webp": return "image/webp";
    case ".gif":  return "image/gif";
    default: return null;
  }
}
function detectImageMime(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (n < 4) return null;
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    // GIF
    if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
    // WEBP (RIFF....WEBP)
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    return null;
  } catch {
    return null;
  }
}

/* ---- เส้นทางเสิร์ฟภาพที่ “ตั้ง Content-Type ให้ถูก” แม้ไฟล์ไม่มีนามสกุล ---- */
app.get("/static-img/:name", (req, res) => {
  const name = req.params.name;
  const full = path.join(STATIC_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).send("Not found");
  const ext = path.extname(full).toLowerCase();
  const mime = mimeFromExt(ext) || detectImageMime(full) || "application/octet-stream";
  res.set("Content-Type", mime);
  res.sendFile(full);
});

/* ----------------------- CORS ----------------------- */
const rawAllowed = (process.env.ALLOWED_REFERER || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const norm = s => (s || "").replace(/\/$/, "").replace(/^https?:\/\//, "");
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = rawAllowed.some(allowed => norm(allowed) === norm(origin));
    cb(ok ? null : new Error("CORS not allowed"), ok);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204,
  credentials: false,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* ----------------------- Middleware ----------------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("combined"));
app.use(express.json({ limit: "64kb" }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

/* ----------------------- KB Loader ----------------------- */
let RAW_TEXT = "";
let watcher = null, watchTimer = null;

function takeContextLimit(s, maxChars = 20000) {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…";
}
function loadKBOnce() {
  if (!fs.existsSync(KB_PATH)) { console.warn(`[KB] not found: ${KB_PATH}`); RAW_TEXT = ""; return; }
  RAW_TEXT = fs.readFileSync(KB_PATH, "utf8");
  console.log(`[KB] Loaded. length=${RAW_TEXT.length}`);
}
function watchKB() {
  if (watcher) return;
  try {
    watcher = fs.watch(path.dirname(KB_PATH), (event, filename) => {
      if (!filename || path.join(path.dirname(KB_PATH), filename) !== KB_PATH) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { try { loadKBOnce(); } catch(e){ console.error("[KB] Reload error:", e.message);} }, 300);
    });
    console.log("[KB] Watching for changes…");
  } catch (e) { console.warn("[KB] fs.watch not available:", e.message); }
}
function ensureKBLoaded(){ if (!RAW_TEXT) loadKBOnce(); }

/* ----------------------- Shop meta ----------------------- */
function parseShopMeta(raw) {
  const name = (raw.match(/ชื่อร้าน[:：]\s*(.+)/) || [])[1]?.trim() || "SUNBI KKOMA KIMBAP";
  const line = (raw.match(/LINE[:：]\s*([^\s]+)/i) || [])[1]?.trim() || null;
  return { name, line };
}

/* ----------------------- Detect language (th/en/es/it/zh/ja/ko) ----------------------- */
const LANG_NAME = { th:"Thai", en:"English", es:"Spanish", it:"Italian", zh:"Chinese", ja:"Japanese", ko:"Korean" };
function detectLang(text){
  const s = String(text || "");
  const low = s.toLowerCase();
  if (/[ก-๙]/.test(s)) return "th";
  if (/[\u3040-\u30ff]/.test(s)) return "ja";
  if (/[\u4e00-\u9fff]/.test(s)) return "zh";
  if (/[가-힣]/.test(s)) return "ko";
  if (/[ñáéíóúü¿¡]/i.test(s) || /\b(necesito|menú|precio|por\s+favor|hola|dónde|gracias)\b/.test(low)) return "es";
  if (/\b(ciao|grazie|per\s+favore|bisogno|menù|orari|prezzo|apertura|chiusura|ristorante|indirizzo)\b/.test(low)) return "it";
  return "en";
}
function isTextInLang(text, lang){
  const t = String(text||"");
  switch(lang){
    case "th": return /[ก-๙]/.test(t);
    case "ja": return /[\u3040-\u30ff]/.test(t);
    case "zh": return /[\u4e00-\u9fff]/.test(t);
    case "ko": return /[가-힣]/.test(t);
    case "es": return /[ñáéíóúü¿¡]/i.test(t) || /\b(el|la|los|las|de|del|y|que)\b/i.test(t);
    case "it": return /\b(il|lo|la|gli|le|del|della|dei|degli|e|che)\b/i.test(t) || /[àèéìòù]/i.test(t);
    case "en": default: return /[A-Za-z]/.test(t) && !(/[ก-๙\u3040-\u30ff\u4e00-\u9fff가-힣]/.test(t));
  }
}

/* ----------------------- KB topics (must use KB) ----------------------- */
const KB_TOPICS = [
  /เวลา|เปิด|ปิด|hours?|time|opening|closing|opening\s*hours|กี่โมง|เวลาทำการ/i,
  /(เมนู|men[uúù])/i,
  /ราคา|บาท|price|เท่าไหร่|เท่าไร|cost|how much/i,
  /โปรโมชัน|โปร|promotion|discount|ส่วนลด/i,
  /จอง|reservation|booking|walk[- ]?in|คิว/i,
  /ที่อยู่|address|location|แผนที่|map|สาขา|branch/i,
  /ติดต่อ|contact|โทร|เบอร์|phone|line|facebook|ig|instagram/i
];
function isKBQuestion(q){ return KB_TOPICS.some(rx => rx.test(q)); }

/* ----------------------- Tokenize (Thai-aware) + EN→TH canon ----------------------- */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const segTH = new Intl.Segmenter("th", { granularity: "word" });
const CANON = {
  line:"line", tel:"โทร", phone:"โทร", contact:"ติดต่อ",
  facebook:"facebook", instagram:"ig", ig:"ig",
  opening:"เปิด", open:"เปิด", close:"ปิด", closing:"ปิด",
  hours:"เวลา", hour:"เวลา", time:"เวลา", times:"เวลา",
  menu:"เมนู", "menú":"เมนู", "menù":"เมนู",
  price:"ราคา", cost:"ราคา",
  promotion:"โปรโมชัน", discount:"โปรโมชัน",
  reservation:"จอง", booking:"จอง", walkin:"คิว", walk:"คิว",
  address:"ที่อยู่", location:"ที่อยู่", map:"แผนที่", branch:"สาขา",
};
function tokenize(text){
  const segmented = Array.from(segTH.segment(String(text))).map(s => s.segment).join(" ");
  return segmented.toLowerCase().split(WORD_SPLIT).filter(Boolean).map(t => CANON[t] || t);
}

/* ----------------------- Section extractor (robust Menu) ----------------------- */
function getSectionByHeader(raw, pattern) {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#{1,6}\s*/.test(lines[i]) && pattern.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return "";
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\s*#{1,6}\s*/.test(lines[j])) { end = j; break; }
  }
  return lines.slice(start, end).join("\n");
}

/* ----------------------- Context picker ----------------------- */
function extractRelevantContext(raw, q, maxChars = 2000, askKB = false){
  if (!raw) return "";

  if (askKB && /(เมนู|men[uúù])/i.test(q)) {
    const sec = getSectionByHeader(raw, /(เมนู|men[uúù])/i);
    if (sec && sec.trim()) {
      return sec.length > maxChars ? sec.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…" : sec;
    }
  }

  const lines = raw.split(/\r?\n/);
  const qTokens = tokenize(q);
  const qSet = new Set(qTokens);
  const boosters = askKB ? new Set(["เวลา","เปิด","ปิด","กี่โมง","เมนู","ราคา","โปรโมชัน","จอง","ที่อยู่","ติดต่อ","line","facebook","ig"]) : new Set();
  const scored = [];
  for (let i=0;i<lines.length;i++){
    const line = lines[i];
    const lTokens = tokenize(line);
    if (!lTokens.length) continue;
    const lset = new Set(lTokens);
    let score = 0;
    qSet.forEach(t => { if (lset.has(t)) { score += 1; if (boosters.has(t)) score += 1; }});
    if (/[:：]\s*\S/.test(line)) score += 0.5;
    if (askKB && /(เวลา\s*เปิด|เวลา\s*ปิด|เวลาเปิด-ปิด|เวลาทำการ)/i.test(line)) score += 2;
    if (score > 0) scored.push({ i, score });
  }
  if (!scored.length) return "";

  scored.sort((a,b)=>b.score-a.score);
  const anchors = scored.slice(0,3);
  const chunks = [];
  for (const a of anchors){
    const start = Math.max(0, a.i-5);
    const end = Math.min(lines.length, a.i+6);
    chunks.push(lines.slice(start,end).join("\n"));
  }
  let ctx = chunks.join("\n---\n");
  if (ctx.length > maxChars) ctx = ctx.slice(0,maxChars).replace(/\s+\S*$/,"") + "\n…";
  return ctx;
}

/* ----------------------- Prompts ----------------------- */
const STRICT_PROFILE = ({ shopName, lineId, targetLang, userSample }) => `
SYSTEM RULES:
- TARGET_LANG: ${targetLang} (${LANG_NAME[targetLang] || "Unknown"})
- USER_SAMPLE: """${userSample}"""
- Your output MUST be written in TARGET_LANG only (same language as USER_SAMPLE). Do not include any other language.
- If the CONTEXT is in another language, TRANSLATE the facts into TARGET_LANG; keep names, times and numbers unchanged.

ROLE:
You are a chat assistant for the restaurant "${shopName}".

POLICY:
- Answer ONLY using the provided CONTEXT. Do not guess or invent details.
- If the CONTEXT lacks the needed fact, say politely that the info isn't available and invite the user to contact the shop${lineId ? ` via LINE (${lineId})` : ""}.
- Keep replies polite and concise (≤2 sentences).
- For opening hours / menu / price / promotion / reservation, quote facts directly from the CONTEXT.
`.trim();

const GENERAL_PROFILE = ({ shopName, targetLang, userSample }) => `
SYSTEM RULES:
- TARGET_LANG: ${targetLang} (${LANG_NAME[targetLang] || "Unknown"})
- USER_SAMPLE: """${userSample}"""
- Your output MUST be written in TARGET_LANG only (same language as USER_SAMPLE). Do not include any other language.

ROLE:
You are a chat assistant for the restaurant "${shopName}".

POLICY:
- If the question is outside hours/menu/price/promotion/reservation/address/contact, you may answer generally.
- Do NOT invent store-specific facts (hours/menu/price/etc.) beyond the CONTEXT.
- Keep replies friendly and concise (≤2 sentences).
`.trim();

/* ----------------------- Translator guard ----------------------- */
async function forceTranslateTo(text, targetLang, apiHeaders){
  const name = LANG_NAME[targetLang] || targetLang;
  const prompt = `
Translate the following text into ${name}. 
Output ${name} only, no explanations, no quotes.

TEXT:
"""${text}"""`.trim();

  const r = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 220,
      messages: [
        { role: "system", content: "You are a professional translator." },
        { role: "user", content: prompt }
      ],
    },
    { headers: apiHeaders, timeout: 20000, validateStatus: s => s>=200 && s<500 }
  );
  return r.data?.choices?.[0]?.message?.content?.trim() || text;
}

/* ----------------------- Helper: pick menu images ----------------------- */
function getMenuImages(limit = 8) {
  try {
    if (!fs.existsSync(STATIC_DIR)) return [];
    const all = fs.readdirSync(STATIC_DIR).sort();
    const picked = [];
    for (const f of all) {
      const full = path.join(STATIC_DIR, f);
      const ext = path.extname(f).toLowerCase();
      const byExt = /\.(jpe?g|png|webp|gif)$/i.test(f);
      const byMagic = !ext && detectImageMime(full); // รองรับไฟล์ไร้นามสกุล
      if (byExt || byMagic) picked.push(f);
      if (picked.length >= limit) break;
    }
    // ใช้เส้นทาง /static-img/ เพื่อบังคับ Content-Type ให้ถูก แม้ไฟล์ไม่มีนามสกุล
    return picked.map(f => `${STATIC_BASE_URL}/static-img/${encodeURIComponent(f)}`);
  } catch (e) {
    console.warn("getMenuImages error:", e.message);
    return [];
  }
}

/* ----------------------- Routes ----------------------- */
app.get("/", (_req, res) => res.type("text/plain").send("SUNBI KKOMA KIMBAP Chat API"));

// debug: ตรวจว่ามีไฟล์อะไรบ้าง และตัวไหนถูกพิจารณาว่าเป็นรูป
app.get("/debug/images", (_req, res) => {
  try {
    const exists = fs.existsSync(STATIC_DIR);
    const all = exists ? fs.readdirSync(STATIC_DIR).sort() : [];
    const picked = all.filter(f => {
      const full = path.join(STATIC_DIR, f);
      return /\.(jpe?g|png|webp|gif)$/i.test(f) || (!path.extname(f) && !!detectImageMime(full));
    });
    res.json({
      static_dir: STATIC_DIR,
      exists,
      total_files: all.length,
      picked_count: picked.length,
      picked
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_req, res) => {
  let staticExists = false, staticCount = 0;
  try {
    staticExists = fs.existsSync(STATIC_DIR);
    staticCount = staticExists ? fs.readdirSync(STATIC_DIR).length : 0;
  } catch {}
  res.json({
    ok:true,
    kb_path:KB_PATH,
    kb_loaded:!!RAW_TEXT,
    kb_length:RAW_TEXT.length||0,
    model:CHAT_MODEL,
    static_dir: STATIC_DIR,
    static_base_url: STATIC_BASE_URL,
    static_exists: staticExists,
    static_total_files: staticCount
  });
});

app.post("/chat", async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });

  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });

  try {
    ensureKBLoaded();
    const { name: shopName, line: lineId } = parseShopMeta(RAW_TEXT);
    const targetLang = detectLang(message);

    // Referer
    const origin = req.headers.origin || "";
    const chosenFullReferer =
      rawAllowed.find(r => norm(r) === norm(origin)) || rawAllowed[0] || "https://example.com";
    const apiHeaders = {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": chosenFullReferer,
      "X-Title": "SUNBI KKOMA KIMBAP Chat",
      "User-Agent": "sunbi-kimbap-chat/1.0 (+render)",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const askKB = isKBQuestion(message);
    const kbContext = askKB ? extractRelevantContext(RAW_TEXT, message, 2000, true) : "";

    const sys = askKB
      ? STRICT_PROFILE({ shopName, lineId, targetLang, userSample: message })
      : GENERAL_PROFILE({ shopName, targetLang, userSample: message });

    const systemPrompt = askKB
      ? `${sys}\n\n[CONTEXT]\n${kbContext || "(no relevant facts)"}\n\nFollow all SYSTEM RULES strictly.`
      : `${sys}\n\n[OPTIONAL CONTEXT]\n${takeContextLimit(RAW_TEXT)}\n\nFollow all SYSTEM RULES strictly.`;

    const result = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: CHAT_MODEL,
        temperature: askKB ? 0 : 0.7,
        max_tokens: 240,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      },
      { headers: apiHeaders, timeout: 30000, validateStatus: s => s>=200 && s<500 }
    );

    if (result.status >= 400) {
      const errBody = result.data || {};
      console.error("OpenRouter error:", errBody);
      return res.status(502).json({ error: "LLM upstream error", detail: errBody });
    }

    let reply = result.data?.choices?.[0]?.message?.content?.trim() || "";
    if (reply && !isTextInLang(reply, targetLang)) {
      reply = await forceTranslateTo(reply, targetLang, apiHeaders);
    }

    // ถ้าผู้ใช้ถาม "เมนู/menu/menú/menù" ให้แนบรูปเมนู (รองรับไฟล์ไม่มีนามสกุลด้วย)
    let images = [];
    if (/(เมนู|men[uúù])/i.test(message)) {
      images = getMenuImages();
      console.log("[menu-images]", { dir: STATIC_DIR, count: images.length, sample: images.slice(0,3) });
    }

    res.json({ reply: reply || "Sorry, I can’t answer that right now.", images });
  } catch (err) {
    const detail = err?.response?.data || err?.message || "Server error";
    console.error("Server error:", detail);
    res.status(500).json({ error: "Server error", detail });
  }
});

/* ----------------------- Start ----------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is running on port ${PORT}`);
  try { ensureKBLoaded(); watchKB(); } catch (e) { console.warn("[KB] init error:", e.message); }
});
