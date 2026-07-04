/**
 * LINE OA Bot (Vercel + Google Gemini API version)
 * ไม่ต้องดูแลเซิร์ฟเวอร์เอง - Vercel รันให้อัตโนมัติเมื่อมีคนทัก LINE เข้ามา
 *
 * ไฟล์นี้ต้องอยู่ที่ /api/webhook.js ตามโครงสร้างของ Vercel
 * URL ที่ได้จะเป็น: https://your-project.vercel.app/api/webhook
 */

const line = require("@line/bot-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
      // กดปุ่มมาเฉยๆ ยังไม่มีรายละเอียด ให้พิมพ์ใหม่รวมข้อมูลในข้อความเดียว
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text:
          "📞 ติดต่อทีมงานผู้ช่วยเกษตรกร AI\n\n" +
          "กรุณาพิมพ์ข้อความเดียว โดยใส่เบอร์โทร/คำถามของคุณต่อท้ายคำว่า \"ติดต่อทีมงาน\" เลยครับ เช่น:\n\n" +
          "ติดต่อทีมงาน เบอร์ 08x-xxx-xxxx อยากสอบถามเรื่องสมัครใช้บอทสำหรับกลุ่มเกษตรกร 20 คน",
      });
    }

    // มีรายละเอียดแนบมาด้วย ส่งแจ้งเตือนพร้อมเนื้อหาไปหาเจ้าของบอททันที
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
      const priceReply = await getCropPriceByKeyword(keyword);
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
// เอกสาร: https://upstash.com/
// ============================================================

// ------------ ดึงประวัติการสนทนาของผู้ใช้คนนั้น ------------
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

// ------------ บันทึกประวัติการสนทนา (เก็บย้อนหลังจำกัดจำนวน + หมดอายุอัตโนมัติ) ------------
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

// ------------ ล้างประวัติการสนทนา (คำสั่ง "เริ่มคุยใหม่") ------------
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
// ฟีเจอร์ราคาพืชผลรายวัน (ใช้ MOC Open Data ฟรี ไม่ต้องมี API key)
// เอกสาร: https://data.moc.go.th/OpenData/GISProductPrice
// ============================================================

// ------------ ค้นหารหัสสินค้าจากชื่อ แล้วดึงราคาล่าสุด ------------
async function getCropPriceByKeyword(keyword) {
  // API ต้องระบุ sell_type เป็นภาษาอังกฤษ ลองทีละแบบจนกว่าจะเจอ
  const sellTypes = ["retail", "wholesale"];
  let lastErrorWasTimeout = false;

  for (const sellType of sellTypes) {
    try {
      const searchUrl = `https://dataapi.moc.go.th/gis-products?keyword=${encodeURIComponent(
        keyword
      )}&sell_type=${sellType}`;

      const searchRes = await fetchWithTimeout(
        searchUrl,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
        9000
      );
      const searchData = await searchRes.json();

      if (searchData && searchData.length > 0) {
        const product = searchData[0];
        return await getCropPriceByProductId(product.product_id, product.product_name, sellType);
      }
    } catch (err) {
      console.error(`getCropPriceByKeyword error (${sellType}):`, err);
      lastErrorWasTimeout = err.name === "AbortError";
      // ลองแบบถัดไปต่อ ไม่หยุดทันที
    }
  }

  if (lastErrorWasTimeout) {
    return "ขออภัยครับ ระบบราคาสินค้าของภาครัฐตอบสนองช้าผิดปกติในตอนนี้ กรุณาลองใหม่อีกครั้งในภายหลังครับ";
  }
  return `ขออภัยครับ ไม่พบสินค้าชื่อ "${keyword}" ในฐานข้อมูล ลองพิมพ์ชื่อสินค้าให้ตรงมากขึ้น เช่น "ราคาข้าวหอมมะลิ" หรือ "ราคามะเขือเทศสีดา" ครับ`;
}

// ------------ ดึงราคาสินค้าตามรหัส (ย้อนหลัง 7 วัน) ------------
async function getCropPriceByProductId(productId, productName, sellType) {
  try {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);

    const formatDate = (d) => d.toISOString().split("T")[0];

    const priceUrl =
      `https://dataapi.moc.go.th/gis-product-price?product_id=${productId}` +
      `&from_date=${formatDate(weekAgo)}&to_date=${formatDate(today)}`;

    const priceRes = await fetchWithTimeout(
      priceUrl,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
      9000
    );
    const priceData = await priceRes.json();

    if (!priceData || !priceData.price_list || priceData.price_list.length === 0) {
      return `ขออภัยครับ ยังไม่มีข้อมูลราคาล่าสุดของ "${productName}" ในช่วง 7 วันที่ผ่านมาครับ`;
    }

    const latest = priceData.price_list[priceData.price_list.length - 1];
    const unit = priceData.unit || "หน่วย";
    const typeLabel = sellType === "wholesale" ? "ราคาขายส่ง" : "ราคาขายปลีก";

    let reply =
      `💰 ${typeLabel} - ${priceData.product_name || productName}\n\n` +
      `📅 ข้อมูลล่าสุดวันที่: ${latest.date}\n` +
      `💵 ราคา: ${latest.price_min}-${latest.price_max} บาท/${unit}\n\n` +
      `📊 เฉลี่ย 7 วันที่ผ่านมา: ${priceData.price_min_avg}-${priceData.price_max_avg} บาท/${unit}\n\n` +
      `ข้อมูลจาก: กรมการค้าภายใน กระทรวงพาณิชย์`;

    return reply;
  } catch (err) {
    console.error("getCropPriceByProductId error:", err);
    if (err.name === "AbortError") {
      return "ขออภัยครับ ระบบราคาสินค้าตอบสนองช้าเกินไป กรุณาลองใหม่อีกครั้งครับ";
    }
    return "ขออภัยครับ ระบบดึงราคาสินค้าขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ";
  }
}

// ------------ แปลง error จาก Gemini ให้เป็นข้อความที่เข้าใจง่าย ------------
function getFriendlyErrorMessage(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  const status = err && err.status;

  // ชนโควตาฟรีรายวัน หรือถูก rate limit (429 / RESOURCE_EXHAUSTED)
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

  // ปัญหาการเชื่อมต่อทั่วไป
  return "ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ หากยังไม่ได้ผล ลองพิมพ์ \"ติดต่อทีมงาน\" เพื่อแจ้งทีมงานได้ครับ";
}

// ------------ ส่งแจ้งเตือนไปหาเจ้าของบอท (เมื่อมีคนติดต่อทีมงาน) ------------
async function notifyOwner(event, actionLabel, detail) {
  if (!OWNER_USER_ID) {
    console.error(
      "ยังไม่ได้ตั้งค่า OWNER_USER_ID ใน Environment Variables จึงส่งแจ้งเตือนไม่ได้"
    );
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

    const now = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

    let messageText =
      `🔔 แจ้งเตือน: มีลูกค้า${actionLabel}\n\n` +
      `👤 ชื่อ: ${displayName}\n` +
      `🕐 เวลา: ${now}\n`;

    if (detail) {
      messageText += `\n💬 ข้อความจากลูกค้า:\n"${detail}"\n`;
    }

    messageText += `\nวิธีตอบกลับ: เปิด LINE Official Account Manager (manager.line.biz) > เมนู "แชท" > ค้นหาชื่อ "${displayName}" แล้วพิมพ์ตอบกลับได้โดยตรงครับ`;

    await lineClient.pushMessage(OWNER_USER_ID, {
      type: "text",
      text: messageText,
    });
  } catch (err) {
    console.error("ส่งแจ้งเตือนหาเจ้าของบอทไม่สำเร็จ:", err);
  }
}

// ------------ ตำแหน่งที่แชร์มาจาก LINE (Location message) ------------
async function handleLocationMessage(event) {
  const { latitude, longitude, title } = event.message;
  const weatherReply = await getWeatherByCoords(latitude, longitude, title);

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: weatherReply,
  });
}

// ------------ รูปภาพ: วิเคราะห์โรคพืช ------------
async function handleImageMessage(event) {
  try {
    const imageBuffer = await downloadLineImage(event.message.id);
    const base64Image = imageBuffer.toString("base64");
    const diagnosis = await askGeminiVision(base64Image);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: diagnosis,
    });
  } catch (err) {
    console.error("Image handling error:", err);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: getFriendlyErrorMessage(err),
    });
  }
}

async function downloadLineImage(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------ เรียก Gemini วิเคราะห์รูปภาพ ------------
async function askGeminiVision(base64Image) {
  const systemPrompt = `คุณเป็นผู้เชี่ยวชาญด้านโรคพืชและการเกษตรของไทย
วิเคราะห์รูปภาพที่ได้รับแล้วตอบเป็นภาษาไทยแบบกระชับ อ่านง่ายสำหรับเกษตรกร โดยมีหัวข้อดังนี้:

🔍 สิ่งที่พบ: (อธิบายอาการที่เห็นในรูป)
🌾 คาดว่าเป็น: (ชื่อโรค/ปัญหาที่เป็นไปได้ 1-2 อย่าง)
💊 วิธีแก้เบื้องต้น: (คำแนะนำที่ทำได้จริง 2-3 ข้อ)
⚠️ หมายเหตุ: นี่เป็นคำแนะนำเบื้องต้นจาก AI หากอาการรุนแรงหรือลุกลาม ควรปรึกษาเกษตรอำเภอหรือผู้เชี่ยวชาญในพื้นที่

ตอบให้สั้น กระชับ ไม่เกิน 150 คำ ใช้ภาษาที่เกษตรกรทั่วไปเข้าใจง่าย`;

  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const result = await model.generateContent([
    systemPrompt,
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
    "ช่วยวิเคราะห์รูปพืชนี้ให้หน่อยครับ",
  ]);

  return result.response.text().trim();
}

// ------------ เรียก Gemini ตอบคำถามข้อความทั่วไป (จำบทสนทนาก่อนหน้าได้) ------------
async function askGeminiText(userText, history) {
  const systemPrompt = `คุณเป็นผู้ช่วยเกษตรกรไทย ตอบคำถามเกี่ยวกับการเพาะปลูก ปุ๋ย โรคพืช
ราคาผลผลิต และเทคนิคการเกษตรแบบกระชับ เข้าใจง่าย ไม่เกิน 120 คำ ใช้ภาษาที่เป็นกันเอง
หากคำถามอ้างอิงถึงบทสนทนาก่อนหน้า ให้ใช้บริบทนั้นตอบต่อเนื่องได้เลย`;

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: systemPrompt,
  });

  const chat = model.startChat({ history: history || [] });
  const result = await chat.sendMessage(userText);

  return result.response.text().trim();
}

// ============================================================
// ฟีเจอร์พยากรณ์อากาศ (ใช้ Open-Meteo API ฟรี ไม่ต้องมี API key)
// เอกสาร: https://open-meteo.com/
// ============================================================

// ------------ ค้นหาพิกัดจากชื่อสถานที่ แล้วดึงพยากรณ์อากาศ ------------
async function getWeatherByPlaceName(place) {
  try {
    const geoUrl =
      "https://geocoding-api.open-meteo.com/v1/search?" +
      `name=${encodeURIComponent(place)}&count=1&language=th&format=json`;

    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    if (!geoData.results || geoData.results.length === 0) {
      return `ขออภัยครับ หาสถานที่ชื่อ "${place}" ไม่เจอ ลองพิมพ์เป็นชื่อจังหวัดหรืออำเภอเป็นภาษาไทย/อังกฤษดูอีกครั้งครับ\nหรือกดแชร์ตำแหน่ง (Location) จากเมนู + ในแชทแทนก็ได้ครับ`;
    }

    const location = geoData.results[0];
    const displayName = location.name || place;

    return getWeatherByCoords(location.latitude, location.longitude, displayName);
  } catch (err) {
    console.error("Geocoding error:", err);
    return "ขออภัยครับ ระบบค้นหาตำแหน่งขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ";
  }
}

// ------------ ดึงพยากรณ์อากาศจากพิกัด lat/lon ------------
async function getWeatherByCoords(lat, lon, placeName) {
  try {
    const weatherUrl =
      "https://api.open-meteo.com/v1/forecast?" +
      `latitude=${lat}&longitude=${lon}` +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max" +
      "&timezone=Asia%2FBangkok&forecast_days=4";

    const res = await fetch(weatherUrl);
    const data = await res.json();

    if (!data.daily) {
      return "ขออภัยครับ ดึงข้อมูลพยากรณ์อากาศไม่สำเร็จ กรุณาลองใหม่อีกครั้งครับ";
    }

    const { time, weather_code, temperature_2m_max, temperature_2m_min, precipitation_probability_max } =
      data.daily;

    const dayLabels = ["วันนี้", "พรุ่งนี้", "มะรืนนี้", "อีก 3 วัน"];

    let reply = `🌤️ พยากรณ์อากาศ${placeName ? " - " + placeName : ""}\n\n`;

    for (let i = 0; i < time.length && i < dayLabels.length; i++) {
      const icon = weatherCodeToIcon(weather_code[i]);
      const desc = weatherCodeToThai(weather_code[i]);
      reply += `${dayLabels[i]}: ${icon} ${desc}\n`;
      reply += `   🌡️ ${temperature_2m_min[i]}-${temperature_2m_max[i]}°C  💧 ฝนตก ${precipitation_probability_max[i]}%\n`;
    }

    reply += "\n💡 หากมีโอกาสฝนตกสูง ควรเลี่ยงการฉีดพ่นปุ๋ย/ยาในวันนั้น";

    return reply;
  } catch (err) {
    console.error("Weather fetch error:", err);
    return "ขออภัยครับ ระบบพยากรณ์อากาศขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ";
  }
}

// ------------ แปลงรหัสสภาพอากาศ (WMO code) เป็นข้อความไทย ------------
function weatherCodeToThai(code) {
  const map = {
    0: "ท้องฟ้าแจ่มใส",
    1: "แจ่มใสเป็นส่วนใหญ่",
    2: "มีเมฆบางส่วน",
    3: "มีเมฆมาก",
    45: "หมอก",
    48: "หมอกน้ำแข็ง",
    51: "ฝนปรอยเบา",
    53: "ฝนปรอยปานกลาง",
    55: "ฝนปรอยหนัก",
    61: "ฝนตกเบา",
    63: "ฝนตกปานกลาง",
    65: "ฝนตกหนัก",
    71: "หิมะตกเบา",
    80: "ฝนตกเป็นช่วง",
    81: "ฝนตกเป็นช่วงปานกลาง",
    82: "ฝนตกเป็นช่วงหนัก",
    95: "พายุฝนฟ้าคะนอง",
    96: "พายุฝนฟ้าคะนองมีลูกเห็บ",
  };
  return map[code] || "ไม่ทราบสภาพอากาศ";
}

// ------------ แปลงรหัสสภาพอากาศเป็นไอคอน emoji ------------
function weatherCodeToIcon(code) {
  if (code === 0 || code === 1) return "☀️";
  if (code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if (code === 71) return "❄️";
  if (code === 95 || code === 96) return "⛈️";
  return "🌡️";
}
