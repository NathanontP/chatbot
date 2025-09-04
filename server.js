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

/* ----------------------- Parse minimal shop meta ----------------------- */
function parseShopMeta(raw) {
  const name = (raw.match(/ชื่อร้าน[:：]\s*(.+)/) || [])[1]?.trim() || "SUNBI KKOMA KIMBAP";
  const line = (raw.match(/LINE[:：]\s*([^\s]+)/i) || [])[1]?.trim() || null; // e.g. @sunbikkoma
  return { name, line };
}

/* ----------------------- Topics that must use KB (STRICT) ----------------------- */
const KB_TOPICS = [
  /เวลา|เปิด|ปิด|hours?|time|opening|closing|opening\s*hours|กี่โมง|เวลาทำการ/i,
  /(เมนู|men[uúù])/i,                     // menu, menú, menù
  /ราคา|บาท|price|เท่าไหร่|เท่าไร|cost|how much/i,
  /โปรโมชัน|โปร|promotion|discount|ส่วนลด/i,
  /จอง|reservation|booking|walk[- ]?in|คิว/i,
  /ที่อยู่|address|location|แผนที่|map|สาขา|branch/i,
  /ติดต่อ|contact|โทร|เบอร์|phone|line|facebook|ig|instagram/i
];
function isKBQuestion(q){ return KB_TOPICS.some(rx => rx.test(q)); }

/* ----------------------- Tokenize (Thai-aware) + EN→TH canon for matching ----------------------- */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const segTH = new Intl.Segmenter("th", { granularity: "word" });
// english terms → thai base tokens so we can match Thai lines in .md
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
  return segmented
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map(t => CANON[t] || t);
}

/* ----------------------- Section extractor (robust menu) ----------------------- */
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

  // 1) menu → pull entire menu section (covers menu/menú/menù/เมนู)
  if (askKB && /(เมนู|men[uúù])/i.test(q)) {
    const sec = getSectionByHeader(raw, /(เมนู|men[uúù])/i);
    if (sec && sec.trim()) {
      return sec.length > maxChars ? sec.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…" : sec;
    }
  }

  // 2) token-based relevance
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
    if (/[:：]\s*\S/.test(line)) score += 0.5; // fact-ish
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

/* ----------------------- Prompts (language-agnostic) ----------------------- */
const STRICT_PROFILE = ({ shopName, lineId, userSample }) => `
SYSTEM RULES:
- ALWAYS reply in THE SAME LANGUAGE as the user's message below. Use ONLY that language.
- USER_MESSAGE_SAMPLE:
"""${userSample}"""
- If the CONTEXT is in another language, TRANSLATE the facts into the user's language; keep names, times and numbers unchanged.

ROLE:
You are a chat assistant for the restaurant "${shopName}".

POLICY:
- Answer ONLY using the provided CONTEXT. Do not guess or invent details.
- If the CONTEXT lacks the needed fact, politely say the info isn't available and invite the user to contact the shop${lineId ? ` via LINE (${lineId})` : ""}.
- Keep replies polite and concise (≤2 sentences).
- For opening hours / menu / price / promotion / reservation, quote facts directly from the CONTEXT.
`.trim();

const GENERAL_PROFILE = ({ shopName, userSample }) => `
SYSTEM RULES:
- ALWAYS reply in THE SAME LANGUAGE as the user's message below. Use ONLY that language.
- USER_MESSAGE_SAMPLE:
"""${userSample}"""

ROLE:
You are a chat assistant for the restaurant "${shopName}".

POLICY:
- If the question is outside hours/menu/price/promotion/reservation/address/contact, you may answer generally.
- Do NOT invent store-specific facts (hours/menu/price/etc.) beyond the CONTEXT.
- Keep replies friendly and concise (≤2 sentences).
`.trim();

/* ----------------------- Routes ----------------------- */
app.get("/", (_req, res) => res.type("text/plain").send("SUNBI KKOMA KIMBAP Chat API"));
app.get("/health", (_req, res) => {
  res.json({ ok:true, kb_path:KB_PATH, kb_loaded:!!RAW_TEXT, kb_length:RAW_TEXT.length||0, model:CHAT_MODEL });
});

app.post("/chat", async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });

  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });

  try {
    ensureKBLoaded();
    const { name: shopName, line: lineId } = parseShopMeta(RAW_TEXT);

    // OpenRouter headers (Referer)
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
      ? STRICT_PROFILE({ shopName, lineId, userSample: message })
      : GENERAL_PROFILE({ shopName, userSample: message });

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

    const reply = result.data?.choices?.[0]?.message?.content?.trim() || "ขออภัย ตอบไม่ได้ชั่วคราว";
    res.json({ reply });
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
