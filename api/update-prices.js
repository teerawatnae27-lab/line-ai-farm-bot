/**
 * งานอัปเดตราคาพืชผลประจำวัน (รันอัตโนมัติทุกวันผ่าน Vercel Cron)
 * ดึงราคาจาก MOC API ล่วงหน้า เก็บลง Redis เพื่อให้บอทตอบผู้ใช้ได้ทันที
 * ไม่ต้องรอ API รัฐบาลตอนมีคนถามจริง (แก้ปัญหา API ช้า/timeout)
 *
 * ตั้งเวลาไว้ใน vercel.json ให้รันอัตโนมัติทุกเช้า
 * หรือเปิด URL นี้เองก็ได้เพื่ออัปเดตทันที:
 * https://line-ai-farm-bot.vercel.app/api/update-prices
 */

const { CROP_LIST, fetchCropPriceFromMOC } = require("./crop-price-lib");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PRICE_CACHE_TTL_SECONDS = 90000; // เก็บไว้ ~25 ชั่วโมง (เผื่อ cron รันช้ากว่ากำหนดเล็กน้อย)

async function saveToRedis(key, value) {
  await fetch(`${UPSTASH_URL}/set/price:${encodeURIComponent(key)}?EX=${PRICE_CACHE_TTL_SECONDS}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  });
}

module.exports = async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).send("❌ ยังไม่ได้ตั้งค่า UPSTASH_REDIS_REST_URL/TOKEN");
  }

  const results = { success: [], failed: [] };

  // ทำทีละรายการ (ไม่ทำพร้อมกันหมด เพื่อไม่ให้ยิง request ถล่ม API รัฐบาลพร้อมกันเกินไป)
  for (const keyword of CROP_LIST) {
    try {
      const data = await fetchCropPriceFromMOC(keyword, 15000); // ให้เวลาต่อรายการนานหน่อย เพราะไม่ติด LINE reply token
      if (data) {
        await saveToRedis(keyword, data);
        results.success.push(keyword);
      } else {
        results.failed.push({ keyword, reason: "ไม่พบข้อมูลหรือ API ไม่ตอบสนอง" });
      }
    } catch (err) {
      results.failed.push({ keyword, reason: err.message });
    }
  }

  return res.status(200).json({
    message: `อัปเดตราคาสำเร็จ ${results.success.length}/${CROP_LIST.length} รายการ`,
    ...results,
  });
};
