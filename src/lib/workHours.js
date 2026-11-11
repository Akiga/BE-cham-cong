// Giờ bắt đầu ca chuẩn (giờ Việt Nam, HH:mm). Có thể đổi qua biến môi trường WORK_START_TIME.
const SHIFT_START = /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.WORK_START_TIME || '')
  ? process.env.WORK_START_TIME
  : '08:00';
const [SHIFT_H, SHIFT_M] = SHIFT_START.split(':').map(Number);
const SHIFT_START_MIN = SHIFT_H * 60 + SHIFT_M;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Trả về { day: 'YYYY-MM-DD', minutes } theo giờ Việt Nam (UTC+7, không có DST).
function toVn(timestamp) {
  const shifted = new Date(new Date(timestamp).getTime() + VN_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

/**
 * Tính giờ cộng thêm do vào ca sớm hơn giờ bắt đầu ca. Đây KHÔNG phải tăng ca.
 * Ví dụ: vào 07:00, ra 17:00, ca bắt đầu 08:00 => +1 giờ.
 * Quy tắc:
 *  - Mỗi nhân viên/ngày lấy lần CHECK_IN sớm nhất và CHECK_OUT muộn nhất.
 *  - Phải có CHECK_OUT (sau CHECK_IN) thì mới được cộng.
 *  - Giờ cộng = từ lúc vào đến giờ bắt đầu ca, nhưng không quá thời gian thực tế đã ở lại
 *    (vào 07:00, ra 07:30 chỉ được +0,5).
 * Trả về Map<userId, Map<day, hours>>.
 */
export function computeEarlyBonus(records) {
  const perDay = new Map();

  for (const record of records) {
    if (!record.timestamp) continue;
    const { day, minutes } = toVn(record.timestamp);
    const key = `${record.userId}|${day}`;
    if (!perDay.has(key)) perDay.set(key, { userId: record.userId, day, checkIn: null, checkOut: null });
    const item = perDay.get(key);
    if (record.type === 'CHECK_IN' && (item.checkIn === null || minutes < item.checkIn)) item.checkIn = minutes;
    if (record.type === 'CHECK_OUT' && (item.checkOut === null || minutes > item.checkOut)) item.checkOut = minutes;
  }

  const result = new Map();
  for (const { userId, day, checkIn, checkOut } of perDay.values()) {
    if (checkIn === null || checkOut === null || checkOut <= checkIn) continue;
    const bonusMinutes = Math.min(SHIFT_START_MIN, checkOut) - checkIn;
    if (bonusMinutes <= 0) continue;
    if (!result.has(userId)) result.set(userId, new Map());
    result.get(userId).set(day, Number((bonusMinutes / 60).toFixed(2)));
  }
  return result;
}

export function sumBonus(bonusMap, userId) {
  const days = bonusMap.get(userId);
  if (!days) return 0;
  return Number([...days.values()].reduce((sum, v) => sum + v, 0).toFixed(2));
}

export function vnDayOf(timestamp) {
  return toVn(timestamp).day;
}

export { SHIFT_START };
