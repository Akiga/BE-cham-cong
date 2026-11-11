import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';

export async function auth(req, res, next) {
  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({
      message: 'Vui lòng đăng nhập'
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Luôn lấy quyền và trạng thái tài khoản mới nhất từ database
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        active: true,
        locationId: true
      }
    });

    if (!user || !user.active) {
      return res.status(401).json({
        message: 'Tài khoản không tồn tại hoặc đã bị khóa'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' ||
        error.name === 'TokenExpiredError') {
      return res.status(401).json({
        message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn'
      });
    }

    next(error);
  }
}

export function allow(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'Bạn không có quyền thực hiện thao tác này'
      });
    }

    next();
  };
}