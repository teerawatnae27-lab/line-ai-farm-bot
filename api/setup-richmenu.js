/**
 * Setup Rich Menu อัตโนมัติ
 * เปิด URL นี้ครั้งเดียวหลัง deploy เพื่อสร้างและตั้งค่า Rich Menu ให้บอท
 * ตัวอย่าง: https://line-ai-farm-bot.vercel.app/api/setup-richmenu
 *
 * ทำงานยังไง:
 * 1. สร้าง Rich Menu ใหม่ผ่าน LINE Messaging API (กำหนดปุ่ม 6 ปุ่ม)
 * 2. อัปโหลดรูปภาพเมนู (จากไฟล์ richmenu-image.js ที่แปลงเป็น base64 ไว้แล้ว)
 * 3. ตั้งเป็นเมนูเริ่มต้นให้ผู้ใช้ทุกคน
 */

const richMenuImageBase64 = require("./richmenu-image");

const LINE_API = "https://api.line.me/v2/bot";
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

module.exports = async (req, res) => {
  try {
    if (!ACCESS_TOKEN) {
      return res.status(500).send("❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน Environment Variables");
    }

    // ------------ ขั้นที่ 1: สร้างโครงสร้าง Rich Menu (6 ปุ่ม กริด 3x2) ------------
    const richMenuBody = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "เมนูหลักผู้ช่วยเกษตรกร AI",
      chatBarText: "เมนู",
      areas: [
        // แถวบน
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: "camera", label: "ถ่ายรูปวิเคราะห์" },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: "cameraRoll", label: "เลือกรูปจากอัลบั้ม" },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: "location", label: "เช็คพยากรณ์อากาศ" },
        },
        // แถวล่าง
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: { type: "message", label: "วิธีใช้งาน", text: "วิธีใช้งาน" },
        },
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: "message", label: "ถามคำถามเกษตร", text: "ถามคำถามเกษตร" },
        },
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: "message", label: "ติดต่อทีมงาน", text: "ติดต่อทีมงาน" },
        },
      ],
    };

    const createRes = await fetch(`${LINE_API}/richmenu`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(richMenuBody),
    });

    const createData = await createRes.json();
    if (!createRes.ok) {
      return res.status(500).json({ step: "create richmenu", error: createData });
    }

    const richMenuId = createData.richMenuId;

    // ------------ ขั้นที่ 2: อัปโหลดรูปภาพเมนู ------------
    const imageBuffer = Buffer.from(richMenuImageBase64, "base64");

    // ตรวจสอบเบื้องต้นว่าไฟล์ base64 ไม่ได้ถูกตัดขาดตอนคัดลอกวาง
    if (imageBuffer.length < 50000) {
      return res.status(500).json({
        step: "validate image",
        error:
          "ไฟล์รูปภาพมีขนาดเล็กผิดปกติ (" +
          imageBuffer.length +
          " bytes) น่าจะเกิดจากตอนคัดลอกโค้ด richmenu-image.js ไม่ครบ กรุณาคัดลอกใหม่อีกครั้งให้ครบทั้งบรรทัด",
      });
    }

    const uploadRes = await fetch(`${LINE_API}/richmenu/${richMenuId}/content`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "image/png",
        "Content-Length": String(imageBuffer.length),
      },
      body: imageBuffer,
    });

    if (!uploadRes.ok) {
      let uploadErr = "";
      try {
        uploadErr = await uploadRes.text();
      } catch (e) {
        uploadErr = "(อ่านข้อความ error ไม่ได้)";
      }
      return res.status(500).json({
        step: "upload image",
        status: uploadRes.status,
        statusText: uploadRes.statusText,
        error: uploadErr || "(ไม่มีรายละเอียดเพิ่มเติมจาก LINE)",
        debugInfo: {
          imageBufferLength: imageBuffer.length,
          base64Length: richMenuImageBase64.length,
          base64Preview: richMenuImageBase64.substring(0, 50),
          base64EndPreview: richMenuImageBase64.substring(richMenuImageBase64.length - 50),
        },
      });
    }

    // ------------ ขั้นที่ 3: ตั้งเป็นเมนูเริ่มต้นของทุกคน ------------
    const setDefaultRes = await fetch(`${LINE_API}/user/all/richmenu/${richMenuId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    if (!setDefaultRes.ok) {
      const setErr = await setDefaultRes.text();
      return res.status(500).json({ step: "set default", error: setErr });
    }

    return res.status(200).send(
      `✅ ตั้งค่า Rich Menu สำเร็จ!\n\nRich Menu ID: ${richMenuId}\n\nกลับไปเปิดแอป LINE แล้วดูที่แชทบอทได้เลยครับ เมนู 6 ปุ่มจะขึ้นด้านล่างแชททันที (ถ้ายังไม่ขึ้น ลองปิดแล้วเปิดแชทใหม่)`
    );
  } catch (err) {
    console.error("Setup rich menu error:", err);
    return res.status(500).json({ error: err.message });
  }
};
