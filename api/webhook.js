/**
 * LINE OA Bot (Vercel + Google Gemini API version)
 * ไม่ต้องดูแลเซิร์ฟเวอร์เอง - Vercel รันให้อัตโนมัติเมื่อมีคนทัก LINE เข้ามา
 *
 * ไฟล์นี้ต้องอยู่ที่ /api/webhook.js ตามโครงสร้างของ Vercel
 * URL ที่ได้จะเป็น: https://your-project.vercel.app/api/webhook
 */

const line = require("@line/bot-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { CROP_LIST, formatPriceMessage } = require("./crop-price-lib");

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// รุ่นฟรี ใช้ได้ในปริมาณจำกัดต่อวัน เหมาะกับช่วงเริ่มทดสอบ
const MODEL_NAME = "gemini-2.5-flash";

// User ID ส่วนตัวของเจ้าของบอท (ใช้ส่งแจ้งเตือนเมื่อมีคนกดปุ่ม "ติดต่อทีมงาน")
// วิธีหาค่านี้ดูในไฟล์ README หรือคำแนะนำที่แนบมาด้วย
const OWNER_USER_ID = process.env.OWNER_USER_ID;

// Upstash Redis (ใช้เก็บประวัติบทสนทนาแต่ละคน ให้บอทถามต่อเนื่องได้)
// สมัครฟรีที่ upstash.com แล้วนำ URL/Token มาใส่ใน Environment Variables
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CONVERSATION_TTL_SECONDS = 1800; // เก็บประวัติไว้ 30 นาที นับจากข้อความล่าสุด
const MAX_HISTORY_MESSAGES = 10; // เก็บย้อนหลังสูงสุด 10 ข้อความ (5 รอบถาม-ตอบ)

const lineClient = new line.Client(lineConfig);

// ------------ เรียก fetch แบบมี timeout กันค้าง (ป้องกัน API ภายนอกช้าจนบอทเงียบ) ------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ------------ ฟังก์ชันหลักที่ Vercel เรียกทุกครั้งที่มี request เข้ามา ------------
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("LINE AI Farm Bot webhook is running ✅");
    return;
  }

  try {
    const signature = req.headers["x-line-signature"];
    const rawBody = JSON.stringify(req.body);

    if (!line.validateSignature(rawBody, lineConfig.channelSecret, signature)) {
      res.status(401).send("Invalid signature");
      return;
    }

    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Internal error");
  }
};

// ------------ จัดการแต่ละ event ------------
async function handleEvent(event) {
  // Log userId ไว้ช่วยหา OWNER_USER_ID ตอนตั้งค่าครั้งแรก (ดูได้ที่ Vercel > Logs)
  if (event.source && event.source.userId) {
    console.log("Incoming event from userId:", event.source.userId);
  }

  if (event.type === "message" && event.message.type === "text") {
    return handleTextMessage(event);
  }
  if (event.type === "message" && event.message.type === "image") {
    return handleImageMessage(event);
  }
  if (event.type === "message" && event.message.type === "location") {
    return handleLocationMessage(event);
  }
  return Promise.resolve(null);
}

// ------------ ข้อความตัวอักษร ------------
async function handleTextMessage(event) {
  const text = event.message.text.trim();

  const welcomeMsg =
    "🌱 สวัสดีครับ ผมเป็นผู้ช่วยเกษตรกรอัจฉริยะ\n\n" +
    "📷 ส่งรูปใบ/ต้นพืชที่มีปัญหา ผมจะช่วยวิเคราะห์เบื้องต้นให้ครับ\n" +
    "🌤️ พิมพ์ \"อากาศ ตามด้วยชื่อจังหวัด/อำเภอ\" เช่น \"อากาศ เชียงใหม่\" เพื่อดูพยากรณ์อากาศ\n" +
    "📍 หรือกดแชร์ตำแหน่ง (Location) เพื่อดูพยากรณ์อากาศจากพิกัดจริง แม่นยำกว่า\n" +
    "💰 พิมพ์ \"ราคา ตามด้วยชื่อสินค้า\" เช่น \"ราคาข้าวหอมมะลิ\" เพื่อดูราคาพืชผลล่าสุด\n" +
    "💬 พิมพ์คำถามเกี่ยวกับการเพาะปลูกได้เลย ถามต่อเนื่องได้ บอทจะจำบทสนทนาไว้ให้ (ถ้าอยากเริ่มหัวข้อใหม่ พิมพ์ \"เริ่มคุยใหม่\")\n\n" +
    "🔒 การใช้งานบอทนี้ถือว่ายอมรับการเก็บข้อมูลตามนโยบายความเป็นส่วนตัว พิมพ์ \"ความเป็นส่วนตัว\" เพื่อดูรายละเอียดครับ";

  const privacyMsg =
    "🔒 นโยบายความเป็นส่วนตัว (PDPA)\n\n" +
    "ข้อมูลที่เราเก็บ:\n" +
    "• รูปภาพที่คุณส่งมาวิเคราะห์ (ใช้ชั่วคราวเพื่อส่งให้ AI วิเคราะห์เท่านั้น)\n" +
    "• ข้อความที่คุณพิมพ์คุยกับบอท\n" +
    "• ตำแหน่งที่ตั้ง (เฉพาะตอนคุณกดแชร์ตำแหน่งเพื่อเช็คอากาศ)\n" +
    "• ชื่อโปรไฟล์ LINE (เฉพาะตอนกดปุ่ม \"ติดต่อทีมงาน\" เพื่อให้ทีมงานรู้จักคุณ)\n\n" +
    "วัตถุประสงค์: ใช้เพื่อวิเคราะห์และตอบคำถามการเกษตรเท่านั้น ไม่นำไปขายหรือใช้เพื่อการตลาดอื่นใด\n\n" +
    "ผู้ประมวลผล: รูปภาพและข้อความจะถูกส่งไปยัง Google Gemini API เพื่อวิเคราะห์ ซึ่งอยู่ภายใต้นโยบายความเป็นส่วนตัวของ Google\n\n" +
    "สิทธิของคุณ: สามารถหยุดใช้งานและบล็อกบัญชีนี้ได้ทุกเมื่อ หากต้องการให้ลบข้อมูล พิมพ์ \"ติดต่อทีมงาน\" แจ้งความประสงค์ได้ครับ";

  if (text === "ความเป็นส่วนตัว" || text.toLowerCase() === "pdpa") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: privacyMsg,
    });
  }

  // คำสั่งล้างประวัติการสนทนา เริ่มคุยใหม่
  if (text === "เริ่มคุยใหม่" || text === "ล้างประวัติ") {
    await clearConversationHistory(event.source.userId);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "🔄 ล้างประวัติการสนทนาแล้วครับ เริ่มถามใหม่ได้เลย",
    });
  }

  if (["สวัสดี", "hello", "hi", "help", "เริ่ม"].includes(text.toLowerCase())) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: welcomeMsg,
    });
  }

  // ปุ่มเมนู: วิธีใช้งาน
  if (text === "วิธีใช้งาน") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: welcomeMsg,
    });
  }

  // ปุ่มเมนู: ถามคำถามเกษตร
  if (text === "ถามคำถามเกษตร") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "พิมพ์คำถามเกี่ยวกับการเพาะปลูก ปุ๋ย โรคพืช หรือเทคนิคการเกษตรได้เลยครับ 🌾\nเช่น \"ปลูกพริกใส่ปุ๋ยอะไรดี\" หรือ \"มะเขือเทศใบเหลืองเกิดจากอะไร\"",
    });
  }

  // ปุ่มเมนู: ติดต่อทีมงาน
  if (text.startsWith("ติดต่อทีมงาน")) {
    const detail = text.replace("ติดต่อทีมงาน", "").trim();

    if (!detail) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text:
          "📞 ติดต่อทีมงานผู้ช่วยเกษตรกร AI\n\n" +
          "กรุณาพิมพ์ข้อความเดียว โดยใส่เบอร์โทร/คำถามของคุณต่อท้ายคำว่า \"ติดต่อทีมงาน\" เลยครับ เช่น:\n\n" +
          "ติดต่อทีมงาน เบอร์ 08x-xxx-xxxx อยากสอบถามเรื่องสมัครใช้บอทสำหรับกลุ่มเกษตรกร 20 คน",
      });
    }

    await notifyOwner(event, "ฝากข้อความติดต่อทีมงาน", detail);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ ส่งข้อความถึงทีมงานเรียบร้อยแล้วครับ ทีมงานได้รับรายละเอียดของคุณแล้ว จะติดต่อกลับโดยเร็วที่สุดครับ",
    });
  }

  // คำสั่งพยากรณ์อากาศ: "อากาศ <ชื่อสถานที่>"
  if (text.startsWith("อากาศ")) {
    const place = text.replace("อากาศ", "").trim();
    if (!place) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "กรุณาพิมพ์ชื่อจังหวัด/อำเภอต่อท้ายด้วยครับ เช่น \"อากาศ เชียงใหม่\"\nหรือกดแชร์ตำแหน่ง (Location) จากเมนู + ในแชทก็ได้ครับ",
      });
    }
    const weatherReply = await getWeatherByPlaceName(place);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: weatherReply,
    });
  }

  // คำสั่งราคาพืชผล: "ราคา <ชื่อสินค้า>"
  if (text.startsWith("ราคา")) {
    const keyword = text.replace("ราคา", "").trim();
    if (!keyword) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "กรุณาพิมพ์ชื่อสินค้าต่อท้ายด้วยครับ เช่น \"ราคาข้าวหอมมะลิ\" หรือ \"ราคามะเขือเทศ\"",
      });
    }
    try {
      const priceReply = await getCropPriceFromCache(keyword);
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: priceReply,
      });
    } catch (err) {
      console.error("Price command error:", err);
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยครับ ระบบราคาสินค้าขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ",
      });
    }
  }

  try {
    const userId = event.source.userId;
    const history = await getConversationHistory(userId);
    const aiReply = await askGeminiText(text, history);

    const updatedHistory = [
      ...history,
      { role: "user", parts: [{ text }] },
      { role: "model", parts: [{ text: aiReply }] },
    ];
    await saveConversationHistory(userId, updatedHistory);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: aiReply,
    });
  } catch (err) {
    console.error("askGeminiText error:", err);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: getFriendlyErrorMessage(err),
    });
  }
}

// ============================================================
// ความจำบทสนทนา (ใช้ Upstash Redis ฟรี เก็บประวัติแยกตามผู้ใช้แต่ละคน)
// ============================================================

async function getConversationHistory(userId) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  try {
    const res = await fetch(`${UPSTASH_URL}/get/chat:${userId}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  } catch (err) {
    console.error("getConversationHistory error:", err);
    return [];
  }
}

async function saveConversationHistory(userId, history) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
    await fetch(`${UPSTASH_URL}/set/chat:${userId}?EX=${CONVERSATION_TTL_SECONDS}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(trimmed),
    });
  } catch (err) {
    console.error("saveConversationHistory error:", err);
  }
}

async function clearConversationHistory(userId) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/del/chat:${userId}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch (err) {
    console.error("clearConversationHistory error:", err);
  }
}

// ============================================================
// ฟีเจอร์ราคาพืชผลรายวัน
// ข้อมูลถูกดึงมาเตรียมไว้ล่วงหน้าทุกเช้าโดย api/update-prices.js (Cron)
// แล้วเก็บไว้ใน Redis จุดนี้แค่มาอ่านข้อมูลที่เตรียมไว้ ตอบเร็วเสมอ
// ============================================================

async function getCropPriceFromCache(keyword) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return "ขออภัยครับ ระบบราคาสินค้ายังไม่พร้อมใช้งานในขณะนี้ครับ";
  }

  try {
    const exactMatch = await readPriceCache(keyword);
    if (exactMatch) return formatPriceMessage(exactMatch, keyword);

    const listRes = await fetch(`${UPSTASH_URL}/keys/price:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const listData = await listRes.json();
    const keys = listData.result || [];

    const matchedKey = keys.find((k) => {
      const cropName = decodeURIComponent(k.replace("price:", ""));
      return cropName.includes(keyword) || keyword.includes(cropName);
    });

    if (matchedKey) {
      const cropName = decodeURIComponent(matchedKey.replace("price:", ""));
      const data = await readPriceCache(cropName);
      if (data) return formatPriceMessage(data, keyword);
    }

    const supportedList = CROP_LIST.join(", ");
    return `ขออภัยครับ ยังไม่มีข้อมูลราคาของ "${keyword}" ในระบบครับ\n\nตอนนี้รองรับสินค้า: ${supportedList}\n\nถ้าอยากให้เพิ่มสินค้าอื่น พิมพ์ "ติดต่อทีมงาน" แจ้งชื่อสินค้าที่ต้องการได้ครับ`;
  } catch (err) {
    console.error("getCropPriceFromCache error:", err);
    return "ขออภัยครับ ระบบราคาสินค้าขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ";
  }
}

async function readPriceCache(keyword) {
  const res = await fetch(`${UPSTASH_URL}/get/price:${encodeURIComponent(keyword)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  if (!data.result) return null;
  return JSON.parse(data.result);
}

// ------------ แปลง error จาก Gemini ให้เป็นข้อความที่เข้าใจง่าย ------------
function getFriendlyErrorMessage(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  const status = err && err.status;

  if (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota") ||
    msg.includes("rate limit")
  ) {
    return (
      "🙏 ขออภัยครับ ตอนนี้มีผู้ใช้งานเยอะมาก ระบบขอพักสักครู่\n" +
      "กรุณาลองใหม่อีกครั้งใน 1-2 นาทีนะครับ 🙏"
    );
  }

  return "ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ หากยังไม่ได้ผล ลองพิมพ์ \"ติดต่อทีมงาน\" เพื่อแจ้งทีมงานได้ครับ";
}

// ------------ ส่งแจ้งเตือนไปหาเจ้าของบอท (เมื่อมีคนติดต่อทีมงาน) ------------
async function notifyOwner(event, actionLabel, detail) {
  if (!OWNER_USER_ID) {
    console.error("ยังไม่ได้ตั้งค่า OWNER_USER_ID ใน Environment Variables จึงส่งแจ้งเตือนไม่ได้");
    return;
  }

  try {
    const userId = event.source.userId;
    let displayName = "(ไม่ทราบชื่อ)";

    try {
      const profile = await lineClient.getProfile(userId);
      displayName = profile.displayName;
    } catch (e) {
      console.error("ดึงโปรไฟล์ผู้ใช้ไม่สำเร็จ:", e);
    }

    const now = new Date().toLocaleString("th-TH", {
