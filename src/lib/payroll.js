// Quy tắc tính lương. Có thể đổi số ngày công chuẩn bằng biến môi trường STANDARD_WORK_DAYS.
export const STANDARD_WORK_DAYS = Number(process.env.STANDARD_WORK_DAYS) > 0
  ? Number(process.env.STANDARD_WORK_DAYS)
  : 26;
export const HOURS_PER_DAY = 8;
export const TAX_RATE = 0.1; // Thuế thu nhập 10% trên tổng thu nhập

// Hệ số tiền lương giờ cho từng loại tăng ca
export const OVERTIME_MULTIPLIERS = {
  weekday15: 1.5,
  sunday2: 2,
  sundayNight35: 3.5
};

/**
 * Tính lương một tháng. Không làm tròn.
 *  - Lương theo công = lương cơ bản / ngày công chuẩn × tổng ngày công thực tế
 *  - Lương giờ       = lương cơ bản / ngày công chuẩn / 8
 *  - Giờ cộng thêm   = lương giờ × số giờ (x1)
 *  - Tăng ca         = lương giờ × giờ × hệ số (x1.5 / x2 / x3.5)
 *  - Thuế            = 10% tổng thu nhập
 */
export function calcSalary({
  baseSalary,
  workDays,
  bonusHours,
  overtime,
  dailyAllowance = 0
}) {
  const base = Number(baseSalary) || 0;
  const days = Number(workDays) || 0;
  const allowance = Number(dailyAllowance) || 0;

  const dailyRate = base / STANDARD_WORK_DAYS;
  const hourlyRate = dailyRate / HOURS_PER_DAY;

  const workPay = dailyRate * days;
  const bonusPay = hourlyRate * (Number(bonusHours) || 0);

  const overtimePay = hourlyRate * (
    (Number(overtime.weekday15) || 0) * OVERTIME_MULTIPLIERS.weekday15 +
    (Number(overtime.sunday2) || 0) * OVERTIME_MULTIPLIERS.sunday2 +
    (Number(overtime.sundayNight35) || 0) * OVERTIME_MULTIPLIERS.sundayNight35
  );

  // Phụ cấp theo ngày công, nửa ngày tính 0.5
  const allowancePay = allowance * days;

  // Cộng tất cả thu nhập trước khi tính thuế
  const grossPay = workPay + bonusPay + overtimePay + allowancePay;
  const tax = grossPay * TAX_RATE;

  return {
    workPay,
    bonusPay,
    overtimePay,
    allowancePay,
    grossPay,
    tax,
    netPay: grossPay - tax
  };
}
