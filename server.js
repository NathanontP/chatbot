// server.js (no keyword map / strict, JSON-guarded generation)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

/* ---------- CORS ---------- */
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

/* ---------- RAG ---------- */
const CHAT_MODEL = "openai/gpt-4o-mini";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const KB_PATH = path.join(__dirname, "kb", "restaurant.md");

let KB = [];            // [{ text, embedding:number[]|null }]
let lastKBModified = 0;

const BUSINESS_PROFILE = `คุณคือผู้ช่วยแชตร้านอาหาร "SUNBI KKOMA KIMBAP"
กติกา: ตอบจาก "บริบท" เท่านั้น ห้ามเดา/แต่ง/เพิ่มข้อมูล ถ้าไม่มีคำตอบในบริบทให้ส่ง NO_ANSWER`;

/* ---------- utils ---------- */
function safeCosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return -1;
  let s=0,na=0,nb=0, n=Math.min(a.length,b.length);
  for (let i=0;i<n;i++){ s+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return s/(Math.sqrt(na)*Math.sqrt(nb)+1e-8);
}

// แยกตามหัวข้อ (# ...) เพื่อให้เป็นชิ้น ๆ แม่นขึ้น
function splitSections(md) {
  return md
    .split(/\n(?=# )/)
    .map(t => t.trim())
    .filter(Boolean);
}

async function embed(texts){
  try{
    const res = await axios.post("https://openrouter.ai/api/v1/embeddings", {
      model: EMBEDDING_MODEL, input: texts
    },{
      headers:{
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": rawAllowed[0] || "http://127.0.0.1:5500",
        "X-Title": "My Chatbot",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 60000
    });
    const arr = res.data?.data?.map(d=>d.embedding) || [];
    while (arr.length < texts.length) arr.push(null);
    return arr;
  }catch(e){
    console.error("[EMB] error:", e.response?.data || e.message);
    return Array(texts.length).fill(null);
  }
}

async function ensureKBLoaded(){
  if (!fs.existsSync(KB_PATH)){ console.warn(`[KB] not found: ${KB_PATH}`); KB=[]; return; }
  const st = fs.statSync(KB_PATH);
  if (st.mtimeMs !== lastKBModified){
    lastKBModified = st.mtimeMs;
    console.log(`[KB] Reloading from ${KB_PATH} ...`);
    const raw = fs.readFileSync(KB_PATH, "utf8");
    const chunks = splitSections(raw);
    const embs = await embed(chunks);
    KB = chunks.map((t,i)=> ({ text: t, embedding: embs[i] || null }));
    console.log(`[KB] Reload complete. ${KB.length} chunks`);
  }
}

/* ---------- routes ---------- */
app.get("/health", (_req,res)=>res.send("ok"));

app.post("/chat", async (req,res)=>{
  const message = String(req.body?.message || "").trim();
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
  if (!message) return res.status(400).json({ error: "Message is required" });

  try{
    await ensureKBLoaded();

    // 1) retrieve only by embedding (no manual map)
    let context = "";
    if (KB.length){
      const [qEmb] = await embed([message]);
      if (qEmb){
        const top = KB
          .map((it,idx)=> ({ idx, score: safeCosine(qEmb, it.embedding), text: it.text }))
          .filter(x => x.score > 0)                // ทิ้งที่ embed ว่าง
          .sort((a,b)=> b.score - a.score)
          .slice(0, 4);
        context = top.map((s,i)=>`【${i+1}】\n${s.text}`).join("\n\n");
      }
    }

    const origin = req.headers.origin || "";
    const chosenReferer =
      rawAllowed.find(r => norm(r) === norm(origin)) ||
      rawAllowed[0] || "http://127.0.0.1:5500";

    // 2) บังคับให้ตอบเป็น JSON เท่านั้น (answer/no_answer)
    const systemPrompt = `${BUSINESS_PROFILE}
ให้ตอบเป็น JSON เท่านั้น รูปแบบ:
{"answer": "<คำตอบสั้นจากบริบทเท่านั้น>"} 
ถ้าไม่มีคำตอบในบริบท ให้ตอบ:
{"no_answer": true}`;

    const userPrompt = `คำถาม: ${message}

[บริบท]
${context || "(ว่าง)"}
`;

    const result = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: CHAT_MODEL,
        temperature: 0,
        max_tokens: 220,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
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

    const rawText = result.data?.choices?.[0]?.message?.content?.trim() || "";
    let payload = {};
    try { payload = JSON.parse(rawText); } catch { /* ถ้าไม่ใช่ JSON จะ fallback ด้านล่าง */ }

    if (payload?.no_answer || !payload?.answer){
      return res.json({ reply: "ไม่มีข้อมูลในระบบ กรุณาติดต่อร้านตามช่องทางในบริบท" });
    }
    return res.json({ reply: String(payload.answer).trim() });

  }catch(err){
    console.error("Server error:", err?.response?.data || err.stack || err.message);
    res.status(500).json({ error: err.response?.data || err.message || "Server error" });
  }
});

/* ---------- start ---------- */
app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`✅ Server is running on port ${PORT}`);
});
