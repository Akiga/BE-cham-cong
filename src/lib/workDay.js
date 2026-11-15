// Quy tắc tính công theo số giờ làm thực tế (giờ Việt Nam, UTC+7).
//  - Giờ làm = (giờ ra − giờ vào) − phần giờ nghỉ trưa nằm trong khoảng đó (12:00–13:00).
//  - Đủ 8 giờ trở lên            => 1 công
//  - Từ 4 giờ đến dưới 8 giờ     => 0,5 công
//  - Dưới 4 giờ hoặc thiếu giờ ra => 0 công
//  - Giờ vượt 8 giờ tính tăng ca x1.5 theo bậc 30 phút:
//      dưới 30p = 0, 30p – dưới 60p = 0,5h, 60p – dưới 90p = 1h, ...
export const FULL_DAY_MINUTES = 8 * 60;
export const HALF_DAY_MINUTES = 4 * 60;
export const OT_STEP_MINUTES = 30;
const LUNCH_START = 12 * 60;
const LUNCH_END = 13 * 60;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// { day: 'YYYY-MM-DD', minutes } theo giờ Việt Nam
export function toVn(timestamp) {
  const shifted = new Date(new Date(timestamp).getTime() + VN_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay() // 0 = Chủ nhật
  };
}

export function calcDayWork(checkIn, checkOut) {
  const empty = { netMinutes: 0, workDay: 0, overtimeHours: 0 };
  if (!checkIn || !checkOut) return empty;

  const inVn = toVn(checkIn);
  const outVn = toVn(checkOut);
  if (inVn.day !== outVn.day || outVn.minutes <= inVn.minutes) return empty;

  const gross = outVn.minutes - inVn.minutes;
  const lunch = Math.max(0, Math.min(outVn.minutes, LUNCH_END) - Math.max(inVn.minutes, LUNCH_START));
  const netMinutes = gross - lunch;

  const workDay = netMinutes >= FULL_DAY_MINUTES ? 1 : netMinutes >= HALF_DAY_MINUTES ? 0.5 : 0;
  const extra = Math.max(0, netMinutes - FULL_DAY_MINUTES);
  const overtimeHours = (Math.floor(extra / OT_STEP_MINUTES) * OT_STEP_MINUTES) / 60;

  return { netMinutes, workDay, overtimeHours, weekday: inVn.weekday };
}

// Gom các lần chấm công thành từng ngày: lấy CHECK_IN sớm nhất và CHECK_OUT muộn nhất.
// Trả về Map<userId, Map<day, { workDay, overtimeHours, netMinutes, checkIn, checkOut }>>
export function summarizeDays(records) {
  const perDay = new Map();
  for (const r of records) {
    if (!r.timestamp) continue;
    const t = new Date(r.timestamp);
    const { day } = toVn(t);
    const key = `${r.userId}|${day}`;
    if (!perDay.has(key)) perDay.set(key, { userId: r.userId, day, checkIn: null, checkOut: null });
    const item = perDay.get(key);
    if (r.type === 'CHECK_IN' && (!item.checkIn || t < item.checkIn)) item.checkIn = t;
    if (r.type === 'CHECK_OUT' && (!item.checkOut || t > item.checkOut)) item.checkOut = t;
  }
  const result = new Map();
  for (const { userId, day, checkIn, checkOut } of perDay.values()) {
    if (!result.has(userId)) result.set(userId, new Map());
    result.get(userId).set(day, { ...calcDayWork(checkIn, checkOut), checkIn, checkOut });
  }
  return result;
}
