// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ------------------------------------
// CORS
// ------------------------------------
const rawAllowed = (process.env.ALLOWED_REFERER || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const norm = s => s.replace(/\/$/, "").replace(/^https?:\/\//, "");
const ALLOWED = rawAllowed.map(norm);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    cb(ALLOWED.includes(norm(origin)) ? null : new Error("CORS not allowed"), ALLOWED.includes(norm(origin)));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json());

// ------------------------------------
// RAG
// ------------------------------------
const CHAT_MODEL = "openai/gpt-4o-mini";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const KB_PATH = path.join(__dirname, "kb", "restaurant.md");

let KB = [];
let lastKBModified = 0;

// ปรับ business profile ให้บังคับตอบจาก KB เท่านั้น
let BUSINESS_PROFILE = `คุณคือผู้ช่วยตอบแชตร้านอาหาร
คุณต้องตอบจาก "บริบท" ที่ให้เท่านั้น
ห้ามเดาหรือแต่งข้อมูลเพิ่ม
ถ้าไม่มีข้อมูลในบริบท ให้ตอบว่า "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้าน (โทร/LINE/FB)"`;

// utils
function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// แยก chunk ตามหัวข้อ (# ...)
function chunkTextBySection(text) {
  return text
    .split(/\n(?=# )/) // แยกเมื่อเจอหัวข้อ
    .map(s => s.trim())
    .filter(Boolean);
}

async function embed(texts) {
  const res = await axios.post("https://openrouter.ai/api/v1/embeddings", {
    model: EMBEDDING_MODEL,
    input: texts
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": rawAllowed[0] || "http://127.0.0.1:5500",
      "X-Title": "My Chatbot",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 60000
  });
  return res.data?.data?.map(d => d.embedding) || [];
}

// โหลด KB ใหม่ถ้าไฟล์ถูกแก้ไข
async function ensureKBLoaded() {
  if (!fs.existsSync(KB_PATH)) {
    console.warn(`[KB] not found: ${KB_PATH}`);
    KB = [];
    return;
  }
  const stats = fs.statSync(KB_PATH);
  if (stats.mtimeMs !== lastKBModified) {
    lastKBModified = stats.mtimeMs;
    console.log(`[KB] Reloading from ${KB_PATH} ...`);
    const raw = fs.readFileSync(KB_PATH, "utf8");
    const chunks = chunkTextBySection(raw);
    const embs = await embed(chunks);
    KB = chunks.map((t, i) => ({ text: t, embedding: embs[i] }));
    console.log(`[KB] Reload complete. ${KB.length} chunks`);
  }
}

// โหลดครั้งแรก
ensureKBLoaded().catch(err => {
  console.error("[KB] initial load error:", err?.response?.data || err.message);
  KB = [];
});

// ------------------------------------
// Health
// ------------------------------------
app.get("/health", (_req, res) => res.send("ok"));

// ------------------------------------
// Chat
// ------------------------------------
app.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
  }
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    await ensureKBLoaded(); // โหลด KB ใหม่ถ้าไฟล์เปลี่ยน

    const origin = req.headers.origin || "";
    const chosenReferer =
      rawAllowed.find(r => norm(r) === norm(origin)) ||
      rawAllowed[0] ||
      "http://127.0.0.1:5500";

    let context = "";
    if (KB.length) {
      const [qEmb] = await embed([message]);
      const top = KB.map(it => ({ ...it, score: cosine(qEmb, it.embedding) }))
        .sort((a, b) => b.score - a.score)
        .filter(s => s.score > 0.75) // กรองให้ใช้เฉพาะที่คล้ายจริงๆ
        .slice(0, 4);
      context = top.map((s, i) => `【${i + 1}】\n${s.text}`).join("\n\n");
    }

    // ถ้าไม่มี context ที่คล้ายพอ ให้ตอบว่าไม่มีข้อมูล
    if (!context) {
      return res.json({ reply: "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้าน (โทร/LINE/FB)" });
    }

    const systemPrompt = `${BUSINESS_PROFILE}\n\nบริบทที่เกี่ยวข้อง:\n${context}`;

    const result = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": chosenReferer,
          "X-Title": "My Chatbot",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 60000
      }
    );

    const reply = result.data?.choices?.[0]?.message?.content || "(no reply)";
    res.json({ reply });
  } catch (err) {
    console.error("OpenRouter error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ------------------------------------
// Start
// ------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
