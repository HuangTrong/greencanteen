import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    // Trường cũ: chỉ giữ để không mất dữ liệu đã có — form đăng ký mới không thu thập nữa
    department: { type: String, trim: true },
    className: { type: String, trim: true },
    // Email đăng nhập bằng mật khẩu (hoặc email Google đã xác minh)
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },
    passwordChangedAt: { type: Date },
    // Thời điểm chủ email mở liên kết xác minh. Tài khoản tạo trước khi có bước xác minh không có trường này
    emailVerifiedAt: { type: Date },
    googleId: { type: String },
    facebookId: { type: String },
    // Phân quyền chỉ đổi được bằng lệnh khởi tạo admin hoặc API quản trị có xác thực lại; đăng ký và API cá nhân
    // không đọc các trường này từ body
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    // Tài khoản bị khóa không dùng được phiên nào (services/session.js) và không đăng nhập được
    status: { type: String, enum: ['active', 'locked'], default: 'active' },
    lockedAt: { type: Date },
    lockReason: { type: String, trim: true, maxlength: 300 },
    // Mã kích hoạt do quản trị viên cấp (npm run claim-code) để chủ tài khoản cũ —
    // tạo khi app chưa có xác thực — gắn phương thức đăng nhập và giữ nguyên dữ liệu
    claimCodeHash: { type: String, select: false },
    claimCodeExpiresAt: { type: Date },
    // Trỏ tới UserAvatar; không có nghĩa là chưa đặt ảnh
    avatarId: { type: String },
    ecoPoints: { type: Number, default: 0 },
    totalCheckIns: { type: Number, default: 0 },
    plasticSavedGrams: { type: Number, default: 0 },
    co2SavedGrams: { type: Number, default: 0 },
    badges: [{ type: String }],
    pendingGachaSpins: { type: Number, default: 0 },
    // Chống nhận thưởng lặp: mốc check-in được thưởng gần nhất (thời gian chờ) và băm các ảnh gần đây
    lastRewardedCheckInAt: { type: Date },
    recentImageHashes: { type: [String], default: undefined, select: false },
    // "Outbox": bản ghi CheckIn / GachaReward được ghi vào user CÙNG lệnh cộng điểm hoặc trừ lượt
    // (một document → nguyên tử, không cần transaction), sau đó mới chuyển sang collection riêng.
    // Server dừng giữa chừng → lúc khởi động chuyển nốt (services/rewards.js), không mất hay nhân đôi.
    checkInOutbox: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    gachaOutbox: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  },
  { timestamps: true }
);

// Unique chỉ khi trường có giá trị — tài khoản cũ không có email/googleId/facebookId
const uniqueWhenSet = (field) => ({
  unique: true,
  partialFilterExpression: { [field]: { $type: 'string' } },
});
// Mã SV không phân biệt hoa/thường ("SV01" và "sv01" là một tài khoản) — ràng buộc ở DB để hai yêu cầu đăng ký đồng thời
// cũng không tạo được hai tài khoản (bước tra trước khi ghi trong services/accounts.js không đủ). Tên riêng để không đụng
// index studentId_1 (phân biệt hoa/thường) đã có trên DB đang chạy.
userSchema.index({ studentId: 1 }, { unique: true, name: 'studentId_ci_unique', collation: { locale: 'en', strength: 2 } });
userSchema.index({ email: 1 }, uniqueWhenSet('email'));
userSchema.index({ googleId: 1 }, uniqueWhenSet('googleId'));
userSchema.index({ facebookId: 1 }, uniqueWhenSet('facebookId'));
// Chỉ user còn mục chưa chuyển trong outbox nằm trong các index này (sparse) → tìm để khôi phục rất nhanh
userSchema.index({ 'checkInOutbox._id': 1 }, { sparse: true });
userSchema.index({ 'gachaOutbox._id': 1 }, { sparse: true });
// Phục vụ màn hình quản trị: chỉ số ít admin / tài khoản bị khóa nằm trong index; thống kê tài khoản mới theo ngày
userSchema.index({ role: 1 }, { name: 'role_admin', partialFilterExpression: { role: 'admin' } });
userSchema.index({ status: 1 }, { name: 'status_locked', partialFilterExpression: { status: 'locked' } });
userSchema.index({ createdAt: -1 });

export const User = mongoose.model('User', userSchema);
