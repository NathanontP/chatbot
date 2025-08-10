// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

// อนุญาต origin ตามสภาพแวดล้อม
const ALLOWED = (process.env.ALLOWED_REFERER || "").split(",").map(s => s.trim()).filter(Boolean);
// ถ้ายังไม่ตั้งค่า ให้ปล่อยกว้างตอน dev (ค่อยล็อกตอน deploy)
app.use(cors(ALLOWED.length ? { origin: ALLOWED } : undefined));

app.use(express.json());

// health check
app.get("/health", (req, res) => res.send("ok"));

app.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
  }
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const result = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-4o-mini", // เปลี่ยนได้ตามสิทธิ์
        messages: [{ role: "user", content: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": ALLOWED[0] || process.env.ALLOWED_REFERER || "http://127.0.0.1:5500",
          "X-Title": "My Chatbot",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 60000,
      }
    );

    const reply = result.data?.choices?.[0]?.message?.content || "(no reply)";
    res.json({ reply });
  } catch (err) {
    console.error("OpenRouter error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
