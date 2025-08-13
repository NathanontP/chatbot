require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

/* ----------------------- CORS ----------------------- */
const rawAllowed = (process.env.ALLOWED_REFERER || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const norm = s => s.replace(/\/$/, "").replace(/^https?:\/\//, "");
const ALLOWED = rawAllowed.map(norm);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    cb(ALLOWED.includes(norm(origin)) ? null : new Error("CORS not allowed"),
       ALLOWED.includes(norm(origin)));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

/* ----------------------- Config ----------------------- */
const CHAT_MODEL = "openai/gpt-4o-mini";
const KB_PATH = path.join(__dirname, "kb", "restaurant.md");
const FALLBACK = "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้านตามช่องทางในบริบท";

/** โปรไฟล์/กติกา — บังคับตอบจาก KB เท่านั้น */
const BUSINESS_PROFILE = `คุณคือผู้ช่วยแชตร้านอาหาร "SUNBI KKOMA KIMBAP"
- ตอบจาก "บริบท" ที่ให้เท่านั้น ห้ามเดาหรือแต่งข้อความอื่นเพิ่มเติม
- รูปแบบคำตอบ: ภาษาไทย สุภาพ กระชับ ไม่เกิน 2 ประโยค
- ถ้าไม่มีข้อมูลในบริบท ให้ตอบ: "${FALLBACK}"
- ถ้าเกี่ยวกับเวลาเปิด-ปิด/เมนู/ราคา/โปรโมชัน/การจองโต๊ะ ให้ดึงประโยค/บรรทัดจากบริบทมาใช้โดยตรง
`;

/* ----------------------- KB Loader ----------------------- */
let RAW_TEXT = "";
let lastKBModified = 0;

// ถ้าไฟล์ใหญ่มาก อาจตัดความยาวเพื่อกันเกินโทเคน
function takeContextLimit(s, maxChars = 20000) {
  if (s.length <= maxChars) return s;
  // ตัดแบบสุภาพ ไม่ตัดกลางคำ
  return s.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…";
}

async function ensureKBLoaded() {
  if (!fs.existsSync(KB_PATH)) {
    console.warn(`[KB] not found: ${KB_PATH}`);
    RAW_TEXT = "";
    return;
  }
  const stats = fs.statSync(KB_PATH);
  if (stats.mtimeMs !== lastKBModified) {
    lastKBModified = stats.mtimeMs;
    console.log(`[KB] Reloading from ${KB_PATH} ...`);
    RAW_TEXT = fs.readFileSync(KB_PATH, "utf8");
    console.log(`[KB] Reload complete. length=${RAW_TEXT.length}`);
  }
}

/* ----------------------- Health ----------------------- */
app.get("/health", (_req, res) => res.send("ok"));

/* ----------------------- Chat ----------------------- */
app.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
  if (!message) return res.status(400).json({ error: "Message is required" });

  try {
    await ensureKBLoaded();

    if (!RAW_TEXT) {
      return res.json({ reply: FALLBACK });
    }

    const origin = req.headers.origin || "";
    const chosenReferer =
      rawAllowed.find(r => norm(r) === norm(origin)) ||
      rawAllowed[0] || "http://127.0.0.1:5500";

    const context = takeContextLimit(RAW_TEXT); // ใช้ทั้งไฟล์เป็นบริบทเดียว
    const systemPrompt = `${BUSINESS_PROFILE}\n\n[บริบททั้งหมด]\n${context}\n\nตอบสั้นๆจากบริบทเท่านั้น`;

    const result = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: CHAT_MODEL,
        temperature: 0,
        max_tokens: 200,
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

    const reply = result.data?.choices?.[0]?.message?.content?.trim();
    res.json({ reply: reply || FALLBACK });
  } catch (err) {
    console.error("Server error:", err && (err.response?.data || err.stack || err.message));
    res.status(500).json({ error: err.response?.data || err.message || "Server error" });
  }
});

/* ----------------------- Start ----------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
