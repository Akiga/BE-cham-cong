import { summarizeDays, toVn } from './workDay.js';

// Tự động tạo / cập nhật đơn tăng ca x1.5 (đã duyệt) từ giờ chấm công của một ngày.
//  - Chỉ áp dụng Thứ 2 – Thứ 7, phần giờ vượt 8 giờ làm việc, tính theo bậc 30 phút.
//  - Đơn tự động được nhận biết qua lý do cố định AUTO_REASON (không cần thêm cột vào database).
//    Quản lý có thể từ chối đơn này; đã từ chối thì không tự tạo lại.
//  - Ngày đã có đơn tăng ca x1.5 do người dùng tự gửi (chờ duyệt / đã duyệt) thì bỏ qua để không tính đôi.
export const AUTO_REASON = 'Tự động tính từ chấm công (vượt 8 giờ làm việc)';
const isAuto = r => r.reason === AUTO_REASON;

export async function syncAutoOvertime(prisma, userId, day) {
  const dayStart = new Date(`${day}T00:00:00+07:00`);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const otStart = new Date(`${day}T00:00:00.000Z`); // đơn tăng ca lưu ngày ở 00:00 UTC
  const otEnd = new Date(otStart.getTime() + 86400000);

  const [records, otRows] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { userId, timestamp: { gte: dayStart, lt: dayEnd } },
      select: { userId: true, timestamp: true, type: true }
    }),
    prisma.overtimeRequest.findMany({
      where: { userId, overtimeType: 'WEEKDAY_15', workDate: { gte: otStart, lt: otEnd } }
    })
  ]);

  const info = summarizeDays(records).get(userId)?.get(day);
  const hours = info && info.weekday !== 0 ? info.overtimeHours : 0;

  const autoRow = otRows.find(isAuto) || null;
  const manualActive = otRows.some(r => !isAuto(r) && ['PENDING', 'APPROVED'].includes(r.status));

  if (manualActive || hours <= 0) {
    if (autoRow) await prisma.overtimeRequest.delete({ where: { id: autoRow.id } });
    return null;
  }
  if (autoRow) {
    if (autoRow.status === 'REJECTED' || autoRow.hours === hours) return autoRow;
    return prisma.overtimeRequest.update({ where: { id: autoRow.id }, data: { hours } });
  }
  return prisma.overtimeRequest.create({
    data: {
      userId,
      workDate: otStart,
      hours,
      overtimeType: 'WEEKDAY_15',
      reason: AUTO_REASON,
      status: 'APPROVED',
      reviewNote: 'Tự động duyệt'
    }
  });
}

// Đồng bộ cho nhiều mốc thời gian; lỗi ở đây không làm hỏng thao tác chấm công chính.
export async function syncAutoOvertimeSafe(prisma, userId, timestamps) {
  const days = new Set(timestamps.filter(Boolean).map(t => toVn(t).day));
  for (const day of days) {
    try {
      await syncAutoOvertime(prisma, userId, day);
    } catch (error) {
      console.error('Không đồng bộ được tăng ca tự động', userId, day, error);
    }
  }
}
