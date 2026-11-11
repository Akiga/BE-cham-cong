import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const email = (process.env.ADMIN_EMAIL || 'admin@company.local').toLowerCase();

  // Kiểm tra tài khoản Admin đã tồn tại chưa
  const existingAdmin = await prisma.user.findUnique({
    where: { email }
  });

  if (existingAdmin) {
    // Đã tồn tại thì cập nhật thông tin
    await prisma.user.update({
      where: { email },
      data: {
        fullName: process.env.ADMIN_NAME || 'Quản trị viên',
        role: 'ADMIN'
      }
    });

    console.log('Tài khoản Admin đã tồn tại, cập nhật thông tin thành công');
  } else {
    // Chưa tồn tại thì tạo mới
    const passwordHash = await bcrypt.hash(
      process.env.ADMIN_PASSWORD || 'Admin@123456',
      12
    );

    await prisma.user.create({
      data: {
        fullName: process.env.ADMIN_NAME || 'Quản trị viên',
        email,
        passwordHash,
        role: 'ADMIN',
        baseSalary: 0
      }
    });

    console.log('Đã tạo tài khoản Admin');
  }

  // Tạo địa điểm công ty nếu chưa có
  const count = await prisma.companyLocation.count();

  if (count === 0) {
    await prisma.companyLocation.create({
      data: {
        name: 'Văn phòng chính',
        address: 'Cập nhật địa chỉ công ty',
        latitude: 10.7769,
        longitude: 106.7009,
        radius: 150
      }
    });

    console.log('Đã tạo địa điểm công ty');
  }

  // Tạo ca làm việc nếu chưa có
  const shiftCount = await prisma.workShift.count();

  if (shiftCount === 0) {
    await prisma.workShift.create({
      data: {
        name: 'Hành chính',
        startTime: '08:00',
        endTime: '17:00',
        breakMins: 60
      }
    });

    console.log('Đã tạo ca làm việc');
  }

  console.log('Seed hoàn tất');
} catch (error) {
  console.error('Seed thất bại:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}