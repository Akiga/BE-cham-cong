import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { auth } from '../middleware/auth.js';

const router = Router();

const userSelect = {
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
};

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        message: 'Nhập email và mật khẩu'
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      return res.status(401).json({
        message: 'Email hoặc mật khẩu không đúng'
      });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    const profile = await prisma.user.findUnique({
      where: { id: user.id },
      select: userSelect
    });

    res.json({
      token,
      user: profile
    });
  } catch (error) {
    next(error);
  }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: userSelect
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

export default router;