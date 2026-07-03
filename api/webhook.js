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

const lineClient = new line.Client(lineConfig);

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
  if (event.type === "message" && event.message.type === "text") {
    return handleTextMessage(event);
  }
  if (event.type === "message" && event.message.type === "image") {
    return handleImageMessage(event);
  }
  return Promise.resolve(null);
}

// ------------ ข้อความตัวอักษร ------------
async function handleTextMessage(event) {
  const text = event.message.text.trim();

  const welcomeMsg =
    "🌱 สวัสดีครับ ผมเป็นผู้ช่วยเกษตรกรอัจฉริยะ\n\n" +
    "📷 ส่งรูปใบ/ต้นพืชที่มีปัญหา ผมจะช่วยวิเคราะห์เบื้องต้นให้ครับ\n" +
    "💬 พิมพ์คำถามเกี่ยวกับการเพาะปลูกได้เลย";

  if (["สวัสดี", "hello", "hi", "help", "เริ่ม"].includes(text.toLowerCase())) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: welcomeMsg,
    });
  }

  const aiReply = await askGeminiText(text);
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: aiReply,
  });
}

// ------------ รูปภาพ: วิเคราะห์โรคพืช ------------
async function handleImageMessage(event) {
  const imageBuffer = await downloadLineImage(event.message.id);
  const base64Image = imageBuffer.toString("base64");
  const diagnosis = await askGeminiVision(base64Image);

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: diagnosis,
  });
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

// ------------ เรียก Gemini ตอบคำถามข้อความทั่วไป ------------
async function askGeminiText(userText) {
  const systemPrompt = `คุณเป็นผู้ช่วยเกษตรกรไทย ตอบคำถามเกี่ยวกับการเพาะปลูก ปุ๋ย โรคพืช
ราคาผลผลิต และเทคนิคการเกษตรแบบกระชับ เข้าใจง่าย ไม่เกิน 120 คำ ใช้ภาษาที่เป็นกันเอง`;

  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const result = await model.generateContent([systemPrompt, userText]);

  return result.response.text().trim();
}
