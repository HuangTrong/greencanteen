import crypto from 'crypto';
import { generateClaimCode, normalizeClaimCode } from './accounts.js';
import { matchTotpStep, openSecret, sealSecret } from './totp.js';

const RECOVERY_CODE_COUNT = 8;

/**
 * Lõi bước xác thực thứ hai dùng chung cho quản trị viên và sinh viên: secret TOTP mã hóa AES-256-GCM gắn với chủ tài khoản, mã khôi phục
 * chỉ lưu HMAC với khóa ngoài DB nên lộ DB cũng không dò ngoại tuyến được. `getKey` đọc lúc gọi: chưa có khóa thì không có gì mở được.
 */
export function secondFactorStore(Model, getKey) {
  const codeHash = (code) => crypto.createHmac('sha256', getKey()).update(normalizeClaimCode(code)).digest('hex');
  const seal = (secret, userId) => sealSecret(secret, getKey(), userId);
  const newRecoveryCodes = () => Array.from({ length: RECOVERY_CODE_COUNT }, generateClaimCode);

  function open(sealed, userId) {
    try {
      return openSecret(sealed, getKey(), userId);
    } catch (err) {
      // Đổi khóa mà chưa đăng ký lại, hoặc dữ liệu bị sửa → coi như sai mã, không bao giờ cho qua
      console.error('Không giải mã được secret MFA:', err.message);
      return null;
    }
  }

  return {
    codeHash,
    seal,
    newRecoveryCodes,

    isEnabled: async (userId) => Boolean(await Model.exists({ userId, enabledAt: { $ne: null } })),

    /** Xác nhận thiết lập bằng mã TOTP đầu tiên. Trả về mã khôi phục (hiện đúng một lần) hoặc null nếu sai mã. */
    async finish(user, code) {
      const mfa = await Model.findOne({ userId: user._id, enabledAt: null, pendingSecretEnc: { $ne: null } });
      const secret = mfa && open(mfa.pendingSecretEnc, user._id);
      const step = secret ? matchTotpStep(secret, code) : null;
      if (step === null) return null;

      const recoveryCodes = newRecoveryCodes();
      const finished = await Model.findOneAndUpdate(
        { _id: mfa._id, enabledAt: null, pendingSecretEnc: mfa.pendingSecretEnc },
        {
          $set: {
            secretEnc: mfa.pendingSecretEnc,
            enabledAt: new Date(),
            lastUsedStep: step,
            recoveryCodeHashes: recoveryCodes.map(codeHash),
          },
          $unset: { pendingSecretEnc: 1, enrollCodeHash: 1, enrollCodeExpiresAt: 1 },
        }
      );
      return finished ? recoveryCodes : null;
    },

    /** Kiểm tra mã TOTP (mỗi mã dùng một lần) hoặc mã khôi phục (xóa ngay khi dùng) trong một lệnh nguyên tử. Trả về 'totp', 'recovery' hoặc false */
    async verify(userId, code) {
      const value = typeof code === 'string' ? code.trim() : '';
      if (!value) return false;
      const mfa = await Model.findOne({ userId, enabledAt: { $ne: null } });
      if (!mfa) return false;

      if (/^\d{6}$/.test(value)) {
        const secret = open(mfa.secretEnc, userId);
        const step = secret ? matchTotpStep(secret, value) : null;
        if (step === null) return false;
        const accepted = await Model.findOneAndUpdate(
          { _id: mfa._id, $or: [{ lastUsedStep: null }, { lastUsedStep: { $lt: step } }] },
          { $set: { lastUsedStep: step } }
        );
        return accepted ? 'totp' : false;
      }

      const hash = codeHash(value);
      const consumed = await Model.findOneAndUpdate({ _id: mfa._id, recoveryCodeHashes: hash }, { $pull: { recoveryCodeHashes: hash } });
      return consumed ? 'recovery' : false;
    },
  };
}
