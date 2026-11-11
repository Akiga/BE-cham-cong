
# Website chấm công v3

Ứng dụng chấm công nội bộ chạy local:
- Frontend: React + Vite
- Backend: Node.js + Express
- Database: MongoDB local qua Prisma
- Đăng nhập JWT, phân quyền ADMIN / MANAGER / EMPLOYEE
- Quản lý nhân viên, địa điểm công ty, ca làm, chấm công GPS, nghỉ phép, tăng ca, bảng lương và xuất Excel

## Yêu cầu
- Node.js 20+
- MongoDB Community Server đang chạy trên Windows
- Không bắt buộc cài `mongosh`. `mongod`/dịch vụ MongoDB mới là tiến trình cơ sở dữ liệu.

## 1. Cấu hình MongoDB
Mở `backend/.env` (copy từ `.env.example`) và giữ URL local:
`DATABASE_URL="mongodb://127.0.0.1:27017/cham_cong"`

Nếu MongoDB chạy dưới dạng Windows Service, kiểm tra trong Services rằng dịch vụ MongoDB đang Running.

## 2. Cài đặt và khởi tạo backend
```powershell
cd backend
Copy-Item .env.example .env
npm install
npx prisma generate
npx prisma db push
npm run seed
npm run dev
```
Backend: http://localhost:5000
Health check: http://localhost:5000/api/health

Hãy đổi `JWT_SECRET` và mật khẩu admin trước khi sử dụng thực tế.

## 3. Chạy frontend (mở terminal PowerShell khác)
```powershell
cd frontend
npm install
npm run dev
```
Mở URL Vite hiển thị trong terminal (thường là http://localhost:5173).

## API chính
- `POST /api/auth/login`
- `GET/POST /api/employees`
- `GET/POST /api/locations`
- `GET/POST /api/shifts`
- `GET/POST /api/attendance`
- `POST /api/attendance/punch`
- `GET/POST /api/leaves`
- `GET/POST /api/overtime`
- `GET/POST /api/payroll`
- `GET /api/payroll/export`

## Lưu ý nghiệp vụ
Đây là bộ khung chạy được để phát triển tiếp. Công thức lương trong bản mẫu là công thức minh họa, 
chưa thay thế quy chế lương, thuế, bảo hiểm hoặc quy định pháp luật. 
GPS trên trình duyệt yêu cầu localhost hoặc HTTPS và người dùng cấp quyền vị trí. 
Cần kiểm thử thực tế, bổ sung audit log, backup, chính sách bảo mật và quy trình duyệt trước khi triển khai production.
