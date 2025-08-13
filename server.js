require("dotenv").config();
const BOT_VERSION = "1.1 - KB only";
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

// system prompt base (ไม่รวม context)
const BUSINESS_PROFILE_BASE = `
คุณคือผู้ช่วยตอบแชตร้านอาหาร
คุณต้องตอบเฉพาะข้อมูลที่ปรากฏในบริบทด้านล่างเท่านั้น
ห้ามเดาหรือเติมข้อมูลใด ๆ
ถ้าคำถามไม่ได้มีคำตอบในบริบท ให้ตอบว่า "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้าน (โทร/LINE/FB)"
ห้ามตอบคำถามอื่นที่ไม่เกี่ยวข้องกับบริบท
`;

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
    .split(/\n(?=# )/)
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
app.get("/health", (_req, res) => res.json({ status: "ok", version: BOT_VERSION }));

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
    await ensureKBLoaded();

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
        .filter(s => s.score > 0.9)
        .slice(0, 4);
      context = top.map((s, i) => `【${i + 1}】\n${s.text}`).join("\n\n");
    }

    if (!context) {
      return res.json({ reply: "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้าน (โทร/LINE/FB)", version: BOT_VERSION });
    }

    const systemPrompt = `${BUSINESS_PROFILE_BASE}\n\nบริบท:\n${context}`;

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
    res.json({ reply, version: BOT_VERSION });

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
