/**
 * โมดูลกลางสำหรับดึงราคาพืชผลจาก MOC Open Data
 * ใช้ร่วมกันระหว่าง:
 * - api/update-prices.js (งาน cron ดึงราคาล่วงหน้าทุกเช้า เก็บลง Redis)
 * - api/webhook.js (อ่านราคาจาก Redis มาตอบผู้ใช้ทันที ไม่ต้องรอ API รัฐบาล)
 */

// รายชื่อพืชผลหลักที่ระบบจะดึงราคาเก็บไว้ล่วงหน้าทุกวัน
// เพิ่ม/ลดรายการได้ตามต้องการ (ยิ่งเยอะยิ่งใช้เวลารันนานขึ้น)
const CROP_LIST = [
  "ข้าวหอมมะลิ",
  "ข้าวเปลือกเจ้า",
  "มันสำปะหลัง",
  "ยางแผ่นดิบ",
  "ปาล์มน้ำมัน",
  "ข้าวโพดเลี้ยงสัตว์",
  "มะเขือเทศ",
  "พริกขี้หนู",
  "กล้วยหอมทอง",
  "มะพร้าว",
  "สับปะรด",
  "ทุเรียนหมอนทอง",
  "ลำไย",
  "มังคุด",
  "หอมแดง",
  "กระเทียม",
  "หอมหัวใหญ่",
  "แตงกวา",
  "ถั่วฝักยาว",
  "ผักบุ้ง",
];

// ------------ เรียก fetch แบบมี timeout กันค้าง ------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ------------ ดึงราคาสินค้า 1 รายการจาก MOC API (ใช้ timeout ที่กำหนดได้) ------------
async function fetchCropPriceFromMOC(keyword, timeoutMs) {
  const sellTypes = ["retail", "wholesale"];

  for (const sellType of sellTypes) {
    try {
      const searchUrl = `https://dataapi.moc.go.th/gis-products?keyword=${encodeURIComponent(
        keyword
      )}&sell_type=${sellType}`;

      const searchRes = await fetchWithTimeout(searchUrl, {}, timeoutMs);
      const searchData = await searchRes.json();

      if (!searchData || searchData.length === 0) continue;

      const product = searchData[0];

      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(today.getDate() - 7);
      const formatDate = (d) => d.toISOString().split("T")[0];

      const priceUrl =
        `https://dataapi.moc.go.th/gis-product-price?product_id=${product.product_id}` +
        `&from_date=${formatDate(weekAgo)}&to_date=${formatDate(today)}`;

      const priceRes = await fetchWithTimeout(priceUrl, {}, timeoutMs);
      const priceData = await priceRes.json();

      if (!priceData || !priceData.price_list || priceData.price_list.length === 0) continue;

      const latest = priceData.price_list[priceData.price_list.length - 1];

      return {
        productName: priceData.product_name || product.product_name,
        sellType,
        unit: priceData.unit || "หน่วย",
        latestDate: latest.date,
        priceMin: latest.price_min,
        priceMax: latest.price_max,
        avgMin: priceData.price_min_avg,
        avgMax: priceData.price_max_avg,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`fetchCropPriceFromMOC error (${keyword}, ${sellType}):`, err.message);
      // ลองแบบถัดไปต่อ
    }
  }

  return null; // ไม่พบข้อมูล หรือ API ขัดข้องทั้ง 2 แบบ
}

// ------------ แปลงผลลัพธ์เป็นข้อความสวยงามส่งให้ผู้ใช้ ------------
function formatPriceMessage(data, keyword) {
  if (!data) {
    return `ขออภัยครับ ยังไม่มีข้อมูลราคาของ "${keyword}" ในระบบครับ`;
  }

  const typeLabel = data.sellType === "wholesale" ? "ราคาขายส่ง" : "ราคาขายปลีก";

  return (
    `💰 ${typeLabel} - ${data.productName}\n\n` +
    `📅 ข้อมูลล่าสุดวันที่: ${data.latestDate}\n` +
    `💵 ราคา: ${data.priceMin}-${data.priceMax} บาท/${data.unit}\n\n` +
    `📊 เฉลี่ย 7 วันที่ผ่านมา: ${data.avgMin}-${data.avgMax} บาท/${data.unit}\n\n` +
    `ข้อมูลจาก: กรมการค้าภายใน กระทรวงพาณิชย์ (อัปเดตล่าสุด ${new Date(
      data.updatedAt
    ).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })})`
  );
}

module.exports = {
  CROP_LIST,
  fetchWithTimeout,
  fetchCropPriceFromMOC,
  formatPriceMessage,
};
