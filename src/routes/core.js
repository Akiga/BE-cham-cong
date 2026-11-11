import bcrypt from 'bcryptjs';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { auth, allow } from '../middleware/auth.js';
import { distanceMeters } from '../lib/geo.js';
import { computeEarlyBonus, sumBonus, vnDayOf } from '../lib/workHours.js';

const router = Router();
router.use(auth);
const managers = allow('ADMIN', 'MANAGER');
const admins = allow('ADMIN');

// Tổng giờ cộng thêm nhập thủ công theo nhân viên trong khoảng [start, end)
async function loadManualBonus(start, end, visibleIds) {
  const rows = await prisma.extraHourRecord.findMany({
    where: {
      workDate: { gte: start, lt: end },
      ...(visibleIds !== null ? { userId: { in: visibleIds } } : {})
    },
    select: { userId: true, hours: true }
  });
  const totals = new Map();
  rows.forEach(r => totals.set(r.userId, (totals.get(r.userId) || 0) + Number(r.hours || 0)));
  return totals;
}

// Lấy danh sách ID nhân viên mà tài khoản hiện tại được phép xem
async function getVisibleUserIds(user) {
  if (user.role === 'ADMIN') return null;

  if (user.role === 'MANAGER') {
    if (!user.locationId) return [];

    const users = await prisma.user.findMany({
      where: {
        locationId: user.locationId
      },
      select: { id: true }
    });

    return users.map(item => item.id);
  }

  return [user.id];
}

// Kiểm tra nhân viên có thuộc phạm vi quản lý hay không
async function canAccessEmployee(user, employeeId) {
  if (user.role === 'ADMIN') return true;

  if (user.role === 'EMPLOYEE') {
    return user.id === employeeId;
  }

  if (user.role === 'MANAGER') {
    if (!user.locationId) return false;

    const employee = await prisma.user.findFirst({
      where: {
        id: employeeId,
        locationId: user.locationId
      },
      select: { id: true }
    });

    return Boolean(employee);
  }

  return false;
}

// Tổng hợp số nhân viên, lượt chấm công và yêu cầu đang chờ trên trang tổng quan
router.get('/dashboard', async (req, res, next) => {
  try {
    const visibleIds = await getVisibleUserIds(req.user);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const userWhere = visibleIds === null
      ? {}
      : { id: { in: visibleIds } };

    const recordWhere = visibleIds === null
      ? {}
      : { userId: { in: visibleIds } };

    const [
      employees,
      attendance,
      pendingLeaves,
      pendingOvertime
    ] = await Promise.all([
      req.user.role === 'EMPLOYEE'
        ? Promise.resolve(1)
        : prisma.user.count({
            where: {
              ...userWhere,
              active: true,
              role: 'EMPLOYEE'
            }
          }),

      prisma.attendanceRecord.findMany({
        where: {
          ...recordWhere,
          timestamp: {
            gte: today,
            lt: tomorrow
          }
        },
        orderBy: { timestamp: 'desc' },
        take: 100
      }),

      req.user.role === 'EMPLOYEE'
        ? Promise.resolve(0)
        : prisma.leaveRequest.count({
            where: {
              ...recordWhere,
              status: 'PENDING'
            }
          }),

      req.user.role === 'EMPLOYEE'
        ? Promise.resolve(0)
        : prisma.overtimeRequest.count({
            where: {
              ...recordWhere,
              status: 'PENDING'
            }
          })
    ]);

    res.json({
      employees,
      attendance,
      pendingLeaves,
      pendingOvertime
    });
  } catch (error) {
    next(error);
  }
});

// Danh sách nhân viên
router.get('/employees', managers, async (req, res, next) => {
  try {
    if (req.user.role === 'MANAGER' && !req.user.locationId) {
      return res.status(403).json({
        message: 'Tài khoản Manager chưa được phân công chi nhánh'
      });
    }

    const { search, department, role, active } = req.query;

    const where = {};

    if (req.user.role === 'MANAGER') {
      where.locationId = req.user.locationId;
    }

    if (search) {
      where.OR = [
        { fullName: { contains: String(search), mode: 'insensitive' } },
        { email: { contains: String(search), mode: 'insensitive' } },
        { employeeCode: { contains: String(search), mode: 'insensitive' } },
        { phone: { contains: String(search), mode: 'insensitive' } }
      ];
    }

    if (department) {
      where.department = String(department);
    }

    if (role && ['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(String(role))) {
      where.role = String(role);
    }

    if (active !== undefined) {
      where.active = String(active) === 'true';
    }

    const rows = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        phone: true,
        gender: true,
        dateOfBirth: true,
        address: true,
        department: true,
        position: true,
        hireDate: true,
        role: true,
        baseSalary: true,
        active: true,
        locationId: true,
        location: {
          select: {
            id: true,
            name: true,
            address: true
          }
        },
        createdAt: true
      }
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Tạo nhân viên - chỉ Admin
router.post('/employees', admins, async (req, res, next) => {
  try {
    const {
      employeeCode,
      fullName,
      email,
      password,
      phone,
      gender,
      dateOfBirth,
      address,
      department,
      position,
      hireDate,
      role = 'EMPLOYEE',
      baseSalary = 0,
      locationId
    } = req.body || {};

    if (!fullName?.trim() || !email?.trim() || !password) {
      return res.status(400).json({
        message: 'Vui lòng nhập họ tên, email và mật khẩu'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        message: 'Mật khẩu phải có ít nhất 8 ký tự'
      });
    }

    if (!['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(role)) {
      return res.status(400).json({
        message: 'Vai trò không hợp lệ'
      });
    }

    if (!Number.isFinite(Number(baseSalary)) || Number(baseSalary) < 0) {
      return res.status(400).json({
        message: 'Mức lương không hợp lệ'
      });
    }

    if (role !== 'ADMIN' && !locationId) {
      return res.status(400).json({
        message: 'Vui lòng phân công chi nhánh'
      });
    }

    if (locationId) {
      const location = await prisma.companyLocation.findFirst({
        where: {
          id: locationId,
          active: true
        }
      });

      if (!location) {
        return res.status(400).json({
          message: 'Chi nhánh không tồn tại hoặc đã ngừng hoạt động'
        });
      }
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existing) {
      return res.status(409).json({
        message: 'Email này đã được sử dụng'
      });
    }

    if (employeeCode) {
      const existingCode = await prisma.user.findUnique({
        where: { employeeCode: String(employeeCode).trim() }
      });

      if (existingCode) {
        return res.status(409).json({
          message: 'Mã nhân viên đã tồn tại'
        });
      }
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const row = await prisma.user.create({
      data: {
        employeeCode: employeeCode?.trim() || null,
        fullName: fullName.trim(),
        email: normalizedEmail,
        passwordHash,
        phone: phone || null,
        gender: gender || null,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        address: address || null,
        department: department || null,
        position: position || null,
        hireDate: hireDate ? new Date(hireDate) : null,
        role,
        baseSalary: Number(baseSalary),
        locationId: locationId || null
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        role: true,
        locationId: true,
        active: true
      }
    });

    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        message: 'Email hoặc mã nhân viên đã tồn tại'
      });
    }

    next(error);
  }
});

// Cập nhật thông tin nhân viên - chỉ Admin
router.patch('/employees/:id', admins, async (req, res, next) => {
  try {
    const {
      employeeCode,
      fullName,
      email,
      phone,
      gender,
      dateOfBirth,
      address,
      department,
      position,
      hireDate,
      role,
      baseSalary,
      locationId,
      active
    } = req.body || {};

    const current = await prisma.user.findUnique({
      where: { id: req.params.id }
    });

    if (!current) {
      return res.status(404).json({
        message: 'Không tìm thấy nhân viên'
      });
    }

    if (current.id === req.user.id && active === false) {
      return res.status(400).json({
        message: 'Không thể tự khóa tài khoản đang đăng nhập'
      });
    }

    if (role !== undefined &&
        !['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(role)) {
      return res.status(400).json({
        message: 'Vai trò không hợp lệ'
      });
    }

    const nextRole = role ?? current.role;
    const nextLocationId = locationId === undefined
      ? current.locationId
      : locationId || null;

    if (nextRole !== 'ADMIN' && !nextLocationId) {
      return res.status(400).json({
        message: 'Manager và nhân viên phải được phân công chi nhánh'
      });
    }

    if (nextLocationId) {
      const location = await prisma.companyLocation.findFirst({
        where: {
          id: nextLocationId,
          active: true
        }
      });

      if (!location) {
        return res.status(400).json({
          message: 'Chi nhánh không tồn tại hoặc đã ngừng hoạt động'
        });
      }
    }

    const data = {
      employeeCode: employeeCode === undefined
        ? undefined
        : employeeCode?.trim() || null,
      fullName: fullName === undefined ? undefined : fullName.trim(),
      email: email === undefined
        ? undefined
        : String(email).toLowerCase().trim(),
      phone,
      gender,
      dateOfBirth: dateOfBirth === undefined
        ? undefined
        : dateOfBirth ? new Date(dateOfBirth) : null,
      address,
      department,
      position,
      hireDate: hireDate === undefined
        ? undefined
        : hireDate ? new Date(hireDate) : null,
      role,
      baseSalary: baseSalary === undefined
        ? undefined
        : Number(baseSalary),
      locationId: locationId === undefined
        ? undefined
        : nextLocationId,
      active
    };

    if (data.baseSalary !== undefined &&
        (!Number.isFinite(data.baseSalary) || data.baseSalary < 0)) {
      return res.status(400).json({
        message: 'Mức lương không hợp lệ'
      });
    }

    const row = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        phone: true,
        gender: true,
        dateOfBirth: true,
        address: true,
        department: true,
        position: true,
        hireDate: true,
        role: true,
        baseSalary: true,
        active: true,
        locationId: true,
        location: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    res.json(row);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        message: 'Email hoặc mã nhân viên đã tồn tại'
      });
    }

    next(error);
  }
});

// Đặt lại mật khẩu nhân viên - chỉ Admin
router.patch('/employees/:id/password', admins, async (req, res, next) => {
  try {
    const { password } = req.body || {};

    if (!password || String(password).length < 8) {
      return res.status(400).json({
        message: 'Mật khẩu mới phải có ít nhất 8 ký tự'
      });
    }

    const employee = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true }
    });

    if (!employee) {
      return res.status(404).json({
        message: 'Không tìm thấy nhân viên'
      });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash }
    });

    res.json({
      message: 'Đặt lại mật khẩu thành công'
    });
  } catch (error) {
    next(error);
  }
});

// Lấy danh sách chi nhánh phù hợp với vai trò và chi nhánh được phân công
router.get('/locations', async (req, res, next) => {
  try {
    let where = {};

    if (req.user.role === 'ADMIN') {
      // Admin xem tất cả chi nhánh, kể cả đã ngừng hoạt động
      where = {};
    } else {
      // Manager và Employee chỉ xem chi nhánh được phân công
      if (!req.user.locationId) {
        return res.json([]);
      }

      where = {
        id: req.user.locationId,
        active: true
      };
    }

    const locations = await prisma.companyLocation.findMany({
      where,
      orderBy: { name: 'asc' }
    });

    res.json(locations);
  } catch (error) {
    next(error);
  }
});

// Tạo địa điểm làm việc mới; chỉ Admin được phép thực hiện
router.post('/locations', admins, async (req, res) => {
  const {
    name,
    address,
    latitude,
    longitude,
    radius = 150
  } = req.body || {};

  if (
    !name ||
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(longitude))
  ) {
    return res.status(400).json({
      message: 'Thông tin địa điểm không hợp lệ'
    });
  }

  const location = await prisma.companyLocation.create({
    data: {
      name,
      address,
      latitude: Number(latitude),
      longitude: Number(longitude),
      radius: Number(radius)
    }
  });

  res.status(201).json(location);
});

// Cập nhật thông tin hoặc trạng thái hoạt động của địa điểm
router.patch('/locations/:id', admins, async (req, res) => {
  const {
    name,
    address,
    latitude,
    longitude,
    radius,
    active
  } = req.body || {};

  try {
    const location = await prisma.companyLocation.update({
      where: { id: req.params.id },
      data: {
        name,
        address,
        latitude: latitude === undefined ? undefined : Number(latitude),
        longitude: longitude === undefined ? undefined : Number(longitude),
        radius: radius === undefined ? undefined : Number(radius),
        active
      }
    });

    res.json(location);
  } catch {
    res.status(404).json({
      message: 'Không tìm thấy địa điểm'
    });
  }
});

// Lấy danh sách các ca làm việc đang hoạt động
router.get('/shifts', async (_req, res) => {
  const shifts = await prisma.workShift.findMany({
    where: { active: true },
    orderBy: { name: 'asc' }
  });

  res.json(shifts);
});

// Tạo ca làm việc mới; Admin và Manager được phép thực hiện
router.post('/shifts', managers, async (req, res) => {
  const {
    name,
    startTime,
    endTime,
    breakMins = 0
  } = req.body || {};

  if (!name || !startTime || !endTime) {
    return res.status(400).json({
      message: 'Nhập tên ca, giờ bắt đầu và kết thúc'
    });
  }

  const shift = await prisma.workShift.create({
    data: {
      name,
      startTime,
      endTime,
      breakMins: Number(breakMins)
    }
  });

  res.status(201).json(shift);
});

// Lấy lịch sử chấm công theo khoảng thời gian và phạm vi quyền của tài khoản
router.get('/attendance', async (req, res, next) => {
  try {
    const { from, to, userId } = req.query;
    const visibleIds = await getVisibleUserIds(req.user);

    const where = {};

    if (visibleIds !== null) {
      where.userId = {
        in: visibleIds
      };
    }

    if (userId) {
      if (
        visibleIds !== null &&
        !visibleIds.includes(String(userId))
      ) {
        return res.status(403).json({
          message: 'Bạn không có quyền xem dữ liệu nhân viên này'
        });
      }

      where.userId = String(userId);
    }

    if (from || to) {
      where.timestamp = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {})
      };
    }

    const rows = await prisma.attendanceRecord.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 500
    });

    // Gắn giờ cộng thêm (vào sớm hơn giờ bắt đầu ca) vào dòng CHECK_IN của từng ngày
    const bonus = computeEarlyBonus(rows);
    const attendanceRows = rows.map(row => ({
      ...row,
      earlyBonusHours: row.type === 'CHECK_IN'
        ? (bonus.get(row.userId)?.get(vnDayOf(row.timestamp)) || 0)
        : 0
    }));

    // Giờ cộng thêm nhập thủ công được trả về dưới dạng dòng type = 'EXTRA_HOURS'
    const extraWhere = {};
    if (where.userId) extraWhere.userId = where.userId;
    if (where.timestamp) extraWhere.workDate = where.timestamp;
    const extraRows = await prisma.extraHourRecord.findMany({
      where: extraWhere,
      orderBy: { workDate: 'desc' },
      take: 500
    });

    res.json([
      ...attendanceRows,
      ...extraRows.map(r => ({
        id: r.id,
        userId: r.userId,
        locationId: r.locationId,
        type: 'EXTRA_HOURS',
        timestamp: r.workDate,
        source: 'MANUAL',
        manualBonusHours: r.hours,
        note: `${r.reason}`,
        createdAt: r.createdAt
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
  } catch (error) {
    next(error);
  }
});
// Ghi nhận vào/ra ca sau khi kiểm tra trạng thái trong ngày và vị trí GPS

// Chấm công thủ công bởi Admin/Manager; Manager chỉ thao tác trong chi nhánh của mình.
router.post('/attendance/manual', managers, async (req, res, next) => {
  try {
    const {
      employeeId, date: workDate, mode, checkInTime, checkOutTime, time, reason
    } = req.body || {};

    if (!employeeId || !workDate || !reason?.trim()) {
      return res.status(400).json({ message: 'Vui lòng chọn nhân viên, ngày và nhập lý do' });
    }

    if (!['FULL_DAY', 'MORNING', 'AFTERNOON', 'CHECK_IN', 'CHECK_OUT'].includes(mode)) {
      return res.status(400).json({ message: 'Hình thức chấm công không hợp lệ' });
    }

    const employee = await prisma.user.findFirst({
      where: {
        id: String(employeeId),
        role: 'EMPLOYEE',
        active: true,
        ...(req.user.role === 'MANAGER' ? { locationId: req.user.locationId || '__none__' } : {})
      },
      select: { id: true, locationId: true, fullName: true }
    });

    if (!employee) {
      return res.status(403).json({ message: 'Nhân viên không tồn tại hoặc ngoài chi nhánh được quản lý' });
    }

    if (req.user.role === 'MANAGER' && !req.user.locationId) {
      return res.status(403).json({ message: 'Tài khoản Manager chưa được phân công chi nhánh' });
    }

    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(workDate));
    if (!dateMatch) return res.status(400).json({ message: 'Ngày chấm công không hợp lệ' });

    const makeDate = (clock) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(clock || ''))) return null;
      return new Date(`${workDate}T${clock}:00+07:00`);
    };

    let punches = [];
    let fraction = 1;
    if (mode === 'FULL_DAY') {
      const start = makeDate(checkInTime || '08:00');
      const end = makeDate(checkOutTime || '17:00');
      if (!start || !end || end <= start) return res.status(400).json({ message: 'Giờ vào/ra không hợp lệ' });
      punches = [{ type: 'CHECK_IN', timestamp: start }, { type: 'CHECK_OUT', timestamp: end }];
    } else if (mode === 'MORNING' || mode === 'AFTERNOON') {
      fraction = 0.5;
      const start = mode === 'MORNING' ? makeDate('08:00') : makeDate('13:00');
      const end = mode === 'MORNING' ? makeDate('12:00') : makeDate('17:00');
      punches = [{ type: 'CHECK_IN', timestamp: start }, { type: 'CHECK_OUT', timestamp: end }];
    } else {
      const stamp = makeDate(time);
      if (!stamp) return res.status(400).json({ message: 'Giờ chấm công không hợp lệ' });
      fraction = 1;
      punches = [{ type: mode, timestamp: stamp }];
    }

    const dayStart = new Date(`${workDate}T00:00:00+07:00`);
    const dayEnd = new Date(`${workDate}T00:00:00+07:00`);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const existing = await prisma.attendanceRecord.findMany({
      where: { userId: employee.id, timestamp: { gte: dayStart, lt: dayEnd } }
    });

    if (mode === 'CHECK_OUT' && !existing.some(row => row.type === 'CHECK_IN')) {
      return res.status(409).json({ message: 'Không thể bổ sung giờ ra khi chưa có giờ vào trong ngày' });
    }

    for (const punch of punches) {
      if (existing.some(row => row.type === punch.type)) {
        return res.status(409).json({
          message: `Nhân viên đã có dữ liệu ${punch.type === 'CHECK_IN' ? 'chấm công vào' : 'chấm công ra'} trong ngày này`
        });
      }
    }

    const created = [];
    for (const punch of punches) {
      const row = await prisma.attendanceRecord.create({
        data: {
          userId: employee.id,
          locationId: employee.locationId || null,
          type: punch.type,
          timestamp: punch.timestamp,
          note: `Chấm công thủ công: ${reason.trim()}`,
          source: 'MANUAL',
          workFraction: fraction,
          createdById: req.user.id
        }
      });
      created.push(row);
    }

    res.status(201).json({ message: 'Đã chấm công thủ công', records: created });
  } catch (error) {
    next(error);
  }
});

// Chỉnh sửa một bản ghi chấm công thủ công; chỉ Admin/Manager trong đúng chi nhánh.
router.patch('/attendance/:id/manual', managers, async (req, res, next) => {
  try {
    const { timestamp, reason } = req.body || {};
    const current = await prisma.attendanceRecord.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Không tìm thấy bản ghi chấm công' });
    if (current.source !== 'MANUAL') return res.status(400).json({ message: 'Chỉ được chỉnh sửa bản ghi chấm công thủ công' });

    const employee = await prisma.user.findUnique({ where: { id: current.userId }, select: { locationId: true } });
    if (req.user.role === 'MANAGER' && (!req.user.locationId || employee?.locationId !== req.user.locationId)) {
      return res.status(403).json({ message: 'Bạn không có quyền chỉnh sửa chấm công nhân viên này' });
    }
    if (!timestamp || !reason?.trim() || Number.isNaN(new Date(timestamp).getTime())) {
      return res.status(400).json({ message: 'Vui lòng nhập thời gian và lý do chỉnh sửa' });
    }

    const updated = await prisma.attendanceRecord.update({
      where: { id: current.id },
      data: {
        timestamp: new Date(timestamp),
        note: `${current.note || ''} | Điều chỉnh: ${reason.trim()}`,
        updatedById: req.user.id
      }
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});
// Nhập giờ cộng thêm thủ công (ví dụ làm xuyên trưa); Manager chỉ thao tác trong chi nhánh của mình.
// Đây là giờ cộng thêm, KHÔNG phải tăng ca.
router.post('/extra-hours', managers, async (req, res, next) => {
  try {
    const { employeeId, date: workDate, hours, reason } = req.body || {};
    const value = Number(hours);

    if (!employeeId || !workDate || !String(reason || '').trim()) {
      return res.status(400).json({ message: 'Vui lòng chọn nhân viên, ngày và nhập lý do' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate)) || Number.isNaN(new Date(`${workDate}T12:00:00+07:00`).getTime())) {
      return res.status(400).json({ message: 'Ngày không hợp lệ' });
    }
    if (!Number.isFinite(value) || value <= 0 || value > 8) {
      return res.status(400).json({ message: 'Số giờ cộng thêm phải lớn hơn 0 và không quá 8 giờ' });
    }
    if (req.user.role === 'MANAGER' && !req.user.locationId) {
      return res.status(403).json({ message: 'Tài khoản Manager chưa được phân công chi nhánh' });
    }

    const employee = await prisma.user.findFirst({
      where: {
        id: String(employeeId),
        role: 'EMPLOYEE',
        active: true,
        ...(req.user.role === 'MANAGER' ? { locationId: req.user.locationId } : {})
      },
      select: { id: true, locationId: true }
    });
    if (!employee) {
      return res.status(403).json({ message: 'Nhân viên không tồn tại hoặc ngoài chi nhánh được quản lý' });
    }

    // Lưu ở 12:00 giờ VN để không bị lệch sang tháng khác khi lọc theo UTC
    const day = new Date(`${workDate}T12:00:00+07:00`);
    const dayStart = new Date(`${workDate}T00:00:00+07:00`);
    const dayEnd = new Date(dayStart.getTime() + 86400000);

    const existing = await prisma.extraHourRecord.findFirst({
      where: { userId: employee.id, workDate: { gte: dayStart, lt: dayEnd } }
    });
    if (existing) {
      return res.status(409).json({ message: 'Ngày này đã có giờ cộng thêm thủ công. Hãy xóa bản ghi cũ rồi nhập lại.' });
    }

    const record = await prisma.extraHourRecord.create({
      data: {
        userId: employee.id,
        locationId: employee.locationId || null,
        workDate: day,
        hours: Number(value.toFixed(2)),
        reason: String(reason).trim(),
        createdById: req.user.id
      }
    });
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

// Xóa một bản ghi giờ cộng thêm thủ công trong phạm vi quản lý
router.delete('/extra-hours/:id', managers, async (req, res, next) => {
  try {
    const record = await prisma.extraHourRecord.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ message: 'Không tìm thấy bản ghi giờ cộng thêm' });
    if (!(await canAccessEmployee(req.user, record.userId))) {
      return res.status(403).json({ message: 'Bạn không có quyền xóa bản ghi này' });
    }
    await prisma.extraHourRecord.delete({ where: { id: record.id } });
    res.json({ message: 'Đã xóa giờ cộng thêm' });
  } catch (error) {
    next(error);
  }
});

router.post('/attendance/punch', async (req, res) => {
  const { type, latitude, longitude, note } = req.body || {};

  if (!['CHECK_IN', 'CHECK_OUT'].includes(type)) {
    return res.status(400).json({
      message: 'Loại chấm công không hợp lệ'
    });
  }

  if (
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(longitude))
  ) {
    return res.status(400).json({
      message: 'Thiếu tọa độ GPS'
    });
  }

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const previous = await prisma.attendanceRecord.findFirst({
    where: {
      userId: req.user.id,
      timestamp: {
        gte: start,
        lt: end
      }
    },
    orderBy: { timestamp: 'desc' }
  });

  if (type === 'CHECK_IN' && previous?.type === 'CHECK_IN') {
    return res.status(409).json({
      message: 'Bạn đã chấm công vào hôm nay'
    });
  }

  if (type === 'CHECK_OUT' && (!previous || previous.type !== 'CHECK_IN')) {
    return res.status(409).json({
      message: 'Bạn cần chấm công vào trước khi chấm công ra'
    });
  }

  if (req.user.role !== 'ADMIN' && !req.user.locationId) {
    return res.status(403).json({
      message: 'Tài khoản chưa được phân công chi nhánh. Vui lòng liên hệ Admin.'
    });
  }

  const locations = await prisma.companyLocation.findMany({
    where: {
      active: true,
      ...(req.user.role === 'ADMIN'
        ? {}
        : { id: req.user.locationId })
    }
  });

  if (!locations.length) {
    return res.status(400).json({
      message: 'Chưa cấu hình địa điểm công ty'
    });
  }

  const nearest = locations
    .map(location => ({
      ...location,
      distance: distanceMeters(
        Number(latitude),
        Number(longitude),
        location.latitude,
        location.longitude
      )
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearest.distance > nearest.radius) {
    return res.status(403).json({
      message: `Bạn đang cách ${nearest.name} ${Math.round(nearest.distance)}m, ngoài bán kính ${nearest.radius}m`
    });
  }

  const record = await prisma.attendanceRecord.create({
    data: {
      userId: req.user.id,
      locationId: nearest.id,
      type,
      latitude: Number(latitude),
      longitude: Number(longitude),
      distanceM: nearest.distance,
      note,
      source: 'GPS',
      workFraction: 1
    }
  });

  res.status(201).json(record);
});

// Lấy danh sách đơn nghỉ phép mà tài khoản hiện tại được quyền xem
router.get('/leaves', async (req, res, next) => {
  try {
    const visibleIds = await getVisibleUserIds(req.user);

    const rows = await prisma.leaveRequest.findMany({
      where: visibleIds === null
        ? {}
        : { userId: { in: visibleIds } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Tạo đơn xin nghỉ phép cho tài khoản đang đăng nhập
router.post('/leaves', async (req, res) => {
  const { fromDate, toDate, reason } = req.body || {};

  if (
    !fromDate ||
    !toDate ||
    !reason ||
    new Date(toDate) < new Date(fromDate)
  ) {
    return res.status(400).json({
      message: 'Thông tin đơn nghỉ phép không hợp lệ'
    });
  }

  const leaveRequest = await prisma.leaveRequest.create({
    data: {
      userId: req.user.id,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      reason
    }
  });

  res.status(201).json(leaveRequest);
});

// Duyệt hoặc từ chối đơn nghỉ phép trong phạm vi quản lý
router.patch('/leaves/:id/review', managers, async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body || {};

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        message: 'Trạng thái không hợp lệ'
      });
    }

    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true }
    });

    if (!request) {
      return res.status(404).json({
        message: 'Không tìm thấy đơn'
      });
    }

    if (!(await canAccessEmployee(req.user, request.userId))) {
      return res.status(403).json({
        message: 'Đơn này không thuộc chi nhánh bạn quản lý'
      });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewNote,
        reviewerId: req.user.id
      }
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Lấy danh sách yêu cầu tăng ca mà tài khoản hiện tại được quyền xem
router.get('/overtime', async (req, res, next) => {
  try {
    const visibleIds = await getVisibleUserIds(req.user);

    const rows = await prisma.overtimeRequest.findMany({
      where: visibleIds === null
        ? {}
        : { userId: { in: visibleIds } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Tạo yêu cầu tăng ca cho tài khoản đang đăng nhập
router.post('/overtime', async (req, res) => {
  const { workDate, hours, overtimeType, reason } = req.body || {};
  const allowedTypes = ['WEEKDAY_15', 'SUNDAY_2', 'SUNDAY_NIGHT_35'];

  if (!workDate || !Number.isFinite(Number(hours)) || Number(hours) <= 0 ||
      !allowedTypes.includes(overtimeType) || !String(reason || '').trim()) {
    return res.status(400).json({ message: 'Vui lòng nhập ngày, số giờ, loại tăng ca và lý do hợp lệ' });
  }

  const dateValue = new Date(workDate);
  if (Number.isNaN(dateValue.getTime())) {
    return res.status(400).json({ message: 'Ngày tăng ca không hợp lệ' });
  }

  const overtimeRequest = await prisma.overtimeRequest.create({
    data: {
      userId: req.user.id,
      workDate: dateValue,
      hours: Number(hours),
      overtimeType,
      reason: String(reason).trim()
    }
  });

  res.status(201).json(overtimeRequest);
});

// Duyệt hoặc từ chối yêu cầu tăng ca trong phạm vi quản lý
router.patch('/overtime/:id/review', managers, async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body || {};

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        message: 'Trạng thái không hợp lệ'
      });
    }

    const request = await prisma.overtimeRequest.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true }
    });

    if (!request) {
      return res.status(404).json({
        message: 'Không tìm thấy đơn'
      });
    }

    if (!(await canAccessEmployee(req.user, request.userId))) {
      return res.status(403).json({
        message: 'Đơn này không thuộc chi nhánh bạn quản lý'
      });
    }

    const updated = await prisma.overtimeRequest.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewNote,
        reviewerId: req.user.id
      }
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Tổng hợp ngày công, giờ tăng ca và ngày nghỉ theo tháng
router.get('/payroll', async (req, res, next) => {
  if (!['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(req.user.role)) {
    return res.status(403).json({
      message: 'Bạn không có quyền xem bảng tổng hợp công'
    });
  }

  try {
    const month = String(req.query.month || '');

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        message: 'Tháng không hợp lệ'
      });
    }

    const [year, monthNumber] = month.split('-').map(Number);

    if (monthNumber < 1 || monthNumber > 12) {
      return res.status(400).json({
        message: 'Tháng không hợp lệ'
      });
    }

    const start = new Date(Date.UTC(year, monthNumber - 1, 1));
    const end = new Date(Date.UTC(year, monthNumber, 1));

    const visibleIds = await getVisibleUserIds(req.user);

    const employeeWhere = {
      role: 'EMPLOYEE',
      ...(visibleIds !== null
        ? { id: { in: visibleIds } }
        : {})
    };

    const [users, attendance, overtime, leaves] = await Promise.all([
      prisma.user.findMany({
        where: employeeWhere,
        select: {
          id: true,
          fullName: true,
          employeeCode: true,
          department: true,
          position: true
        },
        orderBy: { fullName: 'asc' }
      }),

      prisma.attendanceRecord.findMany({
        where: {
          timestamp: {
            gte: start,
            lt: end
          },
          type: { in: ['CHECK_IN', 'CHECK_OUT'] },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          type: true,
          timestamp: true,
          workFraction: true
        }
      }),

      prisma.overtimeRequest.findMany({
        where: {
          status: 'APPROVED',
          workDate: {
            gte: start,
            lt: end
          },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          hours: true,
          overtimeType: true
        }
      }),

      prisma.leaveRequest.findMany({
        where: {
          status: 'APPROVED',
          fromDate: { lt: end },
          toDate: { gte: start },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          fromDate: true,
          toDate: true
        }
      })
    ]);

    const workDays = new Map();
    const overtimeTotals = new Map();
    const leaveDays = new Map();
    // Giờ cộng thêm do vào ca sớm hơn giờ bắt đầu ca (không phải tăng ca)
    const earlyBonus = computeEarlyBonus(attendance);
    const manualBonus = await loadManualBonus(start, end, visibleIds);

    // Cộng công theo ngày: ngày đủ công = 1, ca nửa ngày = 0.5.
    // Dùng mức cao nhất trong ngày để cặp CHECK_IN/CHECK_OUT không bị cộng đôi.
    attendance.forEach(record => {
      if (record.type !== 'CHECK_IN') return;
      const day = new Date(record.timestamp).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh'
      });
      if (!workDays.has(record.userId)) workDays.set(record.userId, new Map());
      const daily = workDays.get(record.userId);
      const fraction = Number(record.workFraction ?? 1);
      daily.set(day, Math.max(daily.get(day) || 0, fraction));
    });

    // Cộng giờ tăng ca đã được duyệt theo loại đăng ký
    overtime.forEach(record => {
      const totals = overtimeTotals.get(record.userId) || { weekday15: 0, sunday2: 0, sundayNight35: 0 };
      const hours = Number(record.hours || 0);
      if (record.overtimeType === 'WEEKDAY_15') totals.weekday15 += hours;
      if (record.overtimeType === 'SUNDAY_2') totals.sunday2 += hours;
      if (record.overtimeType === 'SUNDAY_NIGHT_35') totals.sundayNight35 += hours;
      overtimeTotals.set(record.userId, totals);
    });

    // Tính số ngày nghỉ đã được duyệt, tính cả ngày bắt đầu và kết thúc
    leaves.forEach(record => {
      const from = Math.max(
        new Date(record.fromDate).getTime(),
        start.getTime()
      );

      const to = Math.min(
        new Date(record.toDate).getTime(),
        end.getTime() - 86400000
      );

      if (to < from) return;

      const days = Math.floor((to - from) / 86400000) + 1;

      leaveDays.set(
        record.userId,
        (leaveDays.get(record.userId) || 0) + days
      );
    });

    const result = users.map(user => ({
      id: user.id,
      fullName: user.fullName,
      employeeCode: user.employeeCode,
      department: user.department,
      position: user.position,
      month,
      totalWorkDays: Number([...(workDays.get(user.id)?.values() || [])].reduce((sum, value) => sum + value, 0).toFixed(2)),
      overtimeWeekday15: Number((overtimeTotals.get(user.id)?.weekday15 || 0).toFixed(2)),
      overtimeSunday2: Number((overtimeTotals.get(user.id)?.sunday2 || 0).toFixed(2)),
      overtimeSundayNight35: Number((overtimeTotals.get(user.id)?.sundayNight35 || 0).toFixed(2)),
      overtimeHours: Number(((overtimeTotals.get(user.id)?.weekday15 || 0) + (overtimeTotals.get(user.id)?.sunday2 || 0) + (overtimeTotals.get(user.id)?.sundayNight35 || 0)).toFixed(2)),
      earlyBonusHours: sumBonus(earlyBonus, user.id),
      manualBonusHours: Number((manualBonus.get(user.id) || 0).toFixed(2)),
      bonusHours: Number((sumBonus(earlyBonus, user.id) + (manualBonus.get(user.id) || 0)).toFixed(2)),
      leaveDays: leaveDays.get(user.id) || 0
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Tạo mới hoặc cập nhật bảng lương; chỉ Admin được phép thực hiện
router.post('/payroll', admins, async (req, res) => {
  const {
    userId,
    month,
    baseSalary,
    bonus = 0,
    deduction = 0,
    note
  } = req.body || {};

  if (!userId || !month) {
    return res.status(400).json({
      message: 'Thiếu nhân viên hoặc tháng'
    });
  }

  try {
    const salaryRecord = await prisma.salaryRecord.upsert({
      where: {
        userId_month: { userId, month }
      },
      create: {
        userId,
        month,
        baseSalary: Number(baseSalary) || 0,
        bonus: Number(bonus) || 0,
        deduction: Number(deduction) || 0,
        note
      },
      update: {
        baseSalary: Number(baseSalary) || 0,
        bonus: Number(bonus) || 0,
        deduction: Number(deduction) || 0,
        note
      }
    });

    res.status(201).json(salaryRecord);
  } catch {
    res.status(400).json({
      message: 'Không thể lưu bảng lương'
    });
  }
});

// Xuất bảng lương trong phạm vi được phép ra tệp Excel
router.get('/payroll/export', managers, async (req, res, next) => {
  try {
    const month = String(req.query.month || '');

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: 'Tháng không hợp lệ' });
    }

    const [year, monthNumber] = month.split('-').map(Number);

    if (monthNumber < 1 || monthNumber > 12) {
      return res.status(400).json({ message: 'Tháng không hợp lệ' });
    }

    const start = new Date(Date.UTC(year, monthNumber - 1, 1));
    const end = new Date(Date.UTC(year, monthNumber, 1));

    const visibleIds = await getVisibleUserIds(req.user);

    const employeeWhere = {
      role: 'EMPLOYEE',
      ...(visibleIds !== null ? { id: { in: visibleIds } } : {})
    };

    const [users, attendance, overtime, leaves] = await Promise.all([
      prisma.user.findMany({
        where: employeeWhere,
        select: {
          id: true,
          fullName: true,
          employeeCode: true,
          department: true
        },
        orderBy: { fullName: 'asc' }
      }),

      prisma.attendanceRecord.findMany({
        where: {
          timestamp: { gte: start, lt: end },
          type: { in: ['CHECK_IN', 'CHECK_OUT'] },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          type: true,
          timestamp: true,
          workFraction: true
        }
      }),

      prisma.overtimeRequest.findMany({
        where: {
          status: 'APPROVED',
          workDate: { gte: start, lt: end },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          hours: true,
          overtimeType: true
        }
      }),

      prisma.leaveRequest.findMany({
        where: {
          status: 'APPROVED',
          fromDate: { lt: end },
          toDate: { gte: start },
          ...(visibleIds !== null
            ? { userId: { in: visibleIds } }
            : {})
        },
        select: {
          userId: true,
          fromDate: true,
          toDate: true
        }
      })
    ]);

    const workDays = new Map();
    const overtimeTotals = new Map();
    const leaveDays = new Map();
    // Giờ cộng thêm do vào ca sớm hơn giờ bắt đầu ca (không phải tăng ca)
    const earlyBonus = computeEarlyBonus(attendance);
    const manualBonus = await loadManualBonus(start, end, visibleIds);

    attendance.forEach(record => {
      if (record.type !== 'CHECK_IN') return;
      const day = new Date(record.timestamp).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh'
      });
      if (!workDays.has(record.userId)) workDays.set(record.userId, new Map());
      const daily = workDays.get(record.userId);
      const fraction = Number(record.workFraction ?? 1);
      daily.set(day, Math.max(daily.get(day) || 0, fraction));
    });

    overtime.forEach(record => {
      const totals = overtimeTotals.get(record.userId) || { weekday15: 0, sunday2: 0, sundayNight35: 0 };
      const hours = Number(record.hours || 0);
      if (record.overtimeType === 'WEEKDAY_15') totals.weekday15 += hours;
      if (record.overtimeType === 'SUNDAY_2') totals.sunday2 += hours;
      if (record.overtimeType === 'SUNDAY_NIGHT_35') totals.sundayNight35 += hours;
      overtimeTotals.set(record.userId, totals);
    });

    leaves.forEach(record => {
      const from = Math.max(
        new Date(record.fromDate).getTime(),
        start.getTime()
      );

      const to = Math.min(
        new Date(record.toDate).getTime(),
        end.getTime() - 86400000
      );

      if (to < from) return;

      const days = Math.floor((to - from) / 86400000) + 1;

      leaveDays.set(
        record.userId,
        (leaveDays.get(record.userId) || 0) + days
      );
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tong hop cong');

    ws.columns = [
      { header: 'Họ tên nhân viên', key: 'name', width: 28 },
      { header: 'Mã nhân viên', key: 'code', width: 18 },
      { header: 'Phòng ban', key: 'department', width: 22 },
      { header: 'Tháng', key: 'month', width: 14 },
      { header: 'Tổng ngày công', key: 'workDays', width: 18 },
      { header: 'Giờ cộng thêm (vào sớm)', key: 'earlyBonus', width: 24 },
      { header: 'Giờ cộng thêm (thủ công)', key: 'manualBonus', width: 26 },
      { header: 'Tổng giờ cộng thêm', key: 'bonusTotal', width: 22 },
      { header: 'Tăng ca x1.5 (giờ)', key: 'weekday15', width: 20 },
      { header: 'Tăng ca x2 (giờ)', key: 'sunday2', width: 20 },
      { header: 'Tăng ca x3.5 (giờ)', key: 'sundayNight35', width: 22 },
      { header: 'Tổng giờ tăng ca', key: 'overtime', width: 20 },
      { header: 'Tổng ngày nghỉ', key: 'leaveDays', width: 18 }
    ];

    users.forEach(user => {
      ws.addRow({
        name: user.fullName || '',
        code: user.employeeCode || '',
        department: user.department || '',
        month,
        workDays: Number([...(workDays.get(user.id)?.values() || [])].reduce((sum, value) => sum + value, 0).toFixed(2)),
        earlyBonus: sumBonus(earlyBonus, user.id),
        manualBonus: Number((manualBonus.get(user.id) || 0).toFixed(2)),
        bonusTotal: Number((sumBonus(earlyBonus, user.id) + (manualBonus.get(user.id) || 0)).toFixed(2)),
        weekday15: Number((overtimeTotals.get(user.id)?.weekday15 || 0).toFixed(2)),
        sunday2: Number((overtimeTotals.get(user.id)?.sunday2 || 0).toFixed(2)),
        sundayNight35: Number((overtimeTotals.get(user.id)?.sundayNight35 || 0).toFixed(2)),
        overtime: Number(((overtimeTotals.get(user.id)?.weekday15 || 0) + (overtimeTotals.get(user.id)?.sunday2 || 0) + (overtimeTotals.get(user.id)?.sundayNight35 || 0)).toFixed(2)),
        leaveDays: leaveDays.get(user.id) || 0
      });
    });

    // Định dạng tiêu đề
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = {
      horizontal: 'center',
      vertical: 'middle'
    };

    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: 'A1',
      to: 'M1'
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tong-hop-cong-${month}.xlsx"`
    );

    await wb.xlsx.write(res);
    res.end();

  } catch (error) {
    next(error);
  }
});
export default router;
