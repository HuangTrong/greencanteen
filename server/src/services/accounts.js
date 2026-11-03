import crypto from 'crypto';
import { User } from '../models/User.js';
import { hashToken } from './session.js';
import { RateLimitUnavailableError, createRateLimiter } from './rateLimit.js';
import { computeBadges } from './gamification.js';
import { COMMON_PASSWORD_MESSAGE, PERSONAL_PASSWORD_MESSAGE, containsPersonalInfo, isCommonPassword } from './passwordPolicy.js';

export const PROVIDER_FIELDS = { google: 'googleId', facebook: 'facebookId' };

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };
const claimFailures = createRateLimiter({ name: 'claim-fail', max: 10, windowMs: 60 * 60 * 1000 });

export class AccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const accountLocked = () =>
  new AccountError(403, 'account_locked', 'Tài khoản này đang bị khóa. Vui lòng liên hệ quản trị viên.');

export function sendAccountError(res, err, fallbackMessage) {
  if (err instanceof AccountError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // Không biết đã vượt giới hạn hay chưa thì từ chối: bỏ qua bộ đếm đồng nghĩa mở cửa cho dò mật khẩu đúng lúc DB gặp sự cố
  if (err instanceof RateLimitUnavailableError) {
    console.error(err.message);
    return res.status(503).json({ error: 'Hệ thống tạm thời chưa thể xử lý yêu cầu này. Vui lòng thử lại sau ít phút.', code: 'rate_limit_unavailable' });
  }
  console.error(err);
  return res.status(500).json({ error: fallbackMessage, code: 'server_error' });
}

// ---- Chuẩn hóa & kiểm tra dữ liệu nhập ----

export const normalizeName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
export const normalizeStudentId = (v) => (typeof v === 'string' ? v.trim() : '');
export const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export function validateName(name) {
  if (name.length < 2 || name.length > 80) return 'Họ tên cần từ 2 đến 80 ký tự.';
  return null;
}

export function validateStudentId(studentId) {
  if (!studentId) return 'Cần nhập mã sinh viên.';
  if (studentId.length > 40) return 'Mã sinh viên quá dài.';
  return null;
}

// Cú pháp email như ô nhập type=email của trình duyệt (chữ thường vì đã chuẩn hóa): không cho dấu ngoặc,
// dấu phẩy, chú thích... trong địa chỉ dùng để đăng ký và nhận email đặt lại mật khẩu
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateEmail(email) {
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return 'Email không hợp lệ.';
  }
  return null;
}

/** Kiểm tra lỏng cho đăng nhập: tài khoản tạo trước khi siết cú pháp email vẫn đăng nhập được */
export const isPlausibleEmail = (email) => Boolean(email) && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export function validatePassword(password, profile) {
  if (typeof password !== 'string' || password.length < 8) return 'Mật khẩu cần ít nhất 8 ký tự.';
  if (password.length > 128) return 'Mật khẩu tối đa 128 ký tự.';
  if (isCommonPassword(password)) return COMMON_PASSWORD_MESSAGE;
  if (containsPersonalInfo(password, profile)) return PERSONAL_PASSWORD_MESSAGE;
  return null;
}

// ---- Tài khoản ----

/** Tài khoản cũ (tạo bằng luồng "mã SV + họ tên") chưa có phương thức đăng nhập nào */
export function hasCredentials(user) {
  return Boolean(user.passwordChangedAt || user.googleId || user.facebookId);
}

/** Tra mã sinh viên không phân biệt hoa/thường để "SV01" và "sv01" không thành hai tài khoản */
export function findUserByStudentId(studentId) {
  return User.findOne({ studentId }).collation(CASE_INSENSITIVE);
}

export const avatarUrl = (avatarId) => (avatarId ? `/api/avatars/${avatarId}` : null);

export function serializeUser(user) {
  const ecoPoints = user.ecoPoints || 0;
  const totalCheckIns = user.totalCheckIns || 0;
  return {
    id: user._id.toString(),
    studentId: user.studentId,
    name: user.name,
    email: user.email || '',
    avatarUrl: avatarUrl(user.avatarId),
    createdAt: user.createdAt,
    authMethods: {
      password: Boolean(user.passwordChangedAt),
      google: Boolean(user.googleId),
      facebook: Boolean(user.facebookId),
    },
    ecoPoints,
    totalCheckIns,
    plasticSavedGrams: user.plasticSavedGrams || 0,
    co2SavedGrams: user.co2SavedGrams || 0,
    // Huy hiệu suy ra từ tổng điểm/lượt → luôn đúng kể cả khi lần cập nhật huy hiệu trước bị lỗi
    badges: [...new Set([...(user.badges || []), ...computeBadges(totalCheckIns, ecoPoints)])],
    pendingGachaSpins: user.pendingGachaSpins || 0,
  };
}

function duplicateKeyError(err) {
  if (Number(err?.code) !== 11000) return null;
  const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
  if (field === 'email') {
    return new AccountError(409, 'email_taken', 'Email này đã được dùng cho một tài khoản khác.');
  }
  if (field === 'studentId') {
    return new AccountError(409, 'student_id_taken', 'Mã sinh viên này đã có tài khoản. Hãy đăng nhập.');
  }
  return new AccountError(409, 'provider_already_linked', 'Tài khoản đăng nhập này đã liên kết với người dùng khác.');
}

/**
 * Tạo tài khoản mới gắn với mã sinh viên, hoặc nhận lại tài khoản cũ.
 * Không bao giờ gán dữ liệu cũ chỉ vì người dùng gõ trùng mã sinh viên: tài khoản cũ chỉ được
 * nhận khi có mã kích hoạt hợp lệ do quản trị viên cấp; tài khoản đã có phương thức đăng nhập thì từ chối.
 */
export async function createOrClaimAccount({ name, studentId, claimCode, credentials }) {
  const owner = await findUserByStudentId(studentId);

  if (!owner) {
    try {
      const user = await User.create({ studentId, name, ...credentials });
      return { user, claimed: false };
    } catch (err) {
      throw duplicateKeyError(err) || err;
    }
  }

  if (hasCredentials(owner)) {
    throw new AccountError(409, 'student_id_taken', 'Mã sinh viên này đã có tài khoản. Hãy đăng nhập bằng phương thức đã đăng ký.');
  }

  const code = normalizeClaimCode(claimCode);
  if (!code) {
    throw new AccountError(
      409,
      'legacy_claim_required',
      'Mã sinh viên này thuộc một tài khoản tạo trước khi có đăng nhập bảo mật. Nhập mã kích hoạt do quản trị viên cấp để nhận lại điểm và lịch sử.'
    );
  }

  // Giữ chỗ trước khi thử: kiểm tra rồi mới đếm thì nhiều yêu cầu đồng thời cùng lọt qua
  const limitKey = owner.studentId.toLowerCase();
  if (await claimFailures.hit(limitKey)) {
    throw new AccountError(429, 'too_many_attempts', 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau.');
  }

  let claimed;
  try {
    // Điều kiện nằm trong cùng một lệnh cập nhật → mã chỉ dùng được một lần kể cả khi gửi đồng thời
    claimed = await User.findOneAndUpdate(
      {
        _id: owner._id,
        passwordHash: { $exists: false },
        googleId: { $exists: false },
        facebookId: { $exists: false },
        claimCodeHash: hashToken(code),
        claimCodeExpiresAt: { $gt: new Date() },
      },
      { $set: credentials, $unset: { claimCodeHash: 1, claimCodeExpiresAt: 1 } },
      { new: true }
    );
  } catch (err) {
    throw duplicateKeyError(err) || err;
  }

  if (!claimed) throw new AccountError(400, 'invalid_claim_code', 'Mã kích hoạt không đúng hoặc đã hết hạn.');
  await claimFailures.reset(limitKey);
  return { user: claimed, claimed: true };
}

// ---- Mã kích hoạt tài khoản cũ ----

const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateClaimCode() {
  const chars = Array.from({ length: 12 }, () => CLAIM_ALPHABET[crypto.randomInt(CLAIM_ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export function normalizeClaimCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}
