import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { Passkey } from '../models/Passkey.js';
import { User } from '../models/User.js';
import { WebauthnChallenge } from '../models/WebauthnChallenge.js';
import { AccountError } from './accounts.js';
import { clientOrigin } from './config.js';
import { clearCookie, cookieOptions, hashToken, randomToken, readCookie } from './session.js';

const CHALLENGE_COOKIE = 'gc_webauthn';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const MAX_NAME = 60;

const invalidPasskey = () => new AccountError(400, 'passkey_invalid', 'Không xác minh được passkey. Vui lòng thử lại.');

/** RP ID và origin lấy từ cấu hình, không từ request: trang giả mạo tên miền khác không xin được chữ ký dùng cho trang này */
function relyingParty() {
  const origin = clientOrigin();
  return { origin, rpID: new URL(origin).hostname };
}

async function saveChallenge(res, purpose, challenge, userId) {
  const token = randomToken();
  await WebauthnChallenge.create({ tokenHash: hashToken(token), purpose, challenge, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
  res.cookie(CHALLENGE_COOKIE, token, cookieOptions(CHALLENGE_TTL_MS));
}

/** Xóa trong cùng lệnh tìm: một thử thách chỉ dùng được một lần, kể cả khi lần đó thất bại */
function takeChallenge(req, res, purpose) {
  const token = readCookie(req, CHALLENGE_COOKIE);
  clearCookie(res, CHALLENGE_COOKIE);
  return token ? WebauthnChallenge.findOneAndDelete({ tokenHash: hashToken(token), purpose, expiresAt: { $gt: new Date() } }) : null;
}

export const serializePasskey = (passkey) => ({
  id: passkey._id.toString(),
  name: passkey.name,
  backedUp: passkey.backedUp,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt || null,
});

export async function listPasskeys(userId) {
  const passkeys = await Passkey.find({ userId }).sort({ createdAt: 1 }).lean();
  return passkeys.map(serializePasskey);
}

export const hasPasskey = (userId) => Passkey.exists({ userId });

export async function registrationOptions(res, user) {
  const existing = await Passkey.find({ userId: user._id }).select('credentialId transports').lean();
  if (existing.length >= MAX_PASSKEYS) throw new AccountError(409, 'passkey_limit', `Mỗi tài khoản có tối đa ${MAX_PASSKEYS} passkey.`);
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: 'GreenCanteen',
    rpID,
    userName: user.email || user.studentId,
    userDisplayName: user.name,
    userID: Buffer.from(user._id.toString()),
    attestationType: 'none',
    excludeCredentials: existing.map(({ credentialId, transports }) => ({ id: credentialId, transports })),
    // Khóa nằm trong thiết bị và bị khóa bằng sinh trắc hoặc PIN: một lần dùng passkey đã gồm hai yếu tố
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(res, 'register', options.challenge, user._id);
  return options;
}

export async function finishRegistration(req, res, user, response, name) {
  const pending = await takeChallenge(req, res, 'register');
  if (!pending?.userId?.equals(user._id)) throw invalidPasskey();
  const { origin, rpID } = relyingParty();
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch {
    throw invalidPasskey();
  }
  if (!verification.verified) throw invalidPasskey();

  const { credential, credentialBackedUp } = verification.registrationInfo;
  try {
    const passkey = await Passkey.create({
      userId: user._id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      backedUp: credentialBackedUp,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : 'Passkey',
    });
    return serializePasskey(passkey);
  } catch (err) {
    if (Number(err?.code) === 11000) throw invalidPasskey();
    throw err;
  }
}

async function checkAssertion(passkey, response, expectedChallenge) {
  const { origin, rpID } = relyingParty();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: passkey.counter, transports: passkey.transports },
    });
  } catch {
    return false;
  }
  if (!verification.verified) return false;
  // Điều kiện theo bộ đếm cũ: hai yêu cầu đồng thời không cùng ghi được
  const { modifiedCount } = await Passkey.updateOne(
    { _id: passkey._id, counter: passkey.counter },
    { $set: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() } }
  );
  return modifiedCount === 1;
}

/** Không gửi danh sách khóa: trình duyệt tự đề xuất passkey của trang này, người ngoài không dò được email nào có passkey */
export async function loginOptions(res) {
  const options = await generateAuthenticationOptions({ rpID: relyingParty().rpID, userVerification: 'required' });
  await saveChallenge(res, 'login', options.challenge);
  return options;
}

/** Trả về tài khoản của passkey hoặc ném passkey_invalid: mọi lý do thất bại giống hệt nhau */
export async function finishLogin(req, res, response) {
  const pending = await takeChallenge(req, res, 'login');
  if (!pending || typeof response?.id !== 'string') throw invalidPasskey();
  const passkey = await Passkey.findOne({ credentialId: response.id });
  if (!passkey) throw invalidPasskey();
  // userHandle phải trỏ đúng chủ của khóa nếu thiết bị có gửi
  const handle = response.response?.userHandle;
  if (handle && Buffer.from(String(handle), 'base64url').toString() !== passkey.userId.toString()) throw invalidPasskey();
  if (!(await checkAssertion(passkey, response, pending.challenge))) throw invalidPasskey();
  const user = await User.findById(passkey.userId);
  if (!user) throw invalidPasskey();
  return user;
}

// ---- Bước thứ hai của đăng nhập quản trị: chống lừa đảo tốt hơn TOTP vì chữ ký gắn với tên miền ----

export async function adminOptions(res, user) {
  const passkeys = await Passkey.find({ userId: user._id }).select('credentialId transports').lean();
  if (!passkeys.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: relyingParty().rpID,
    userVerification: 'required',
    allowCredentials: passkeys.map(({ credentialId, transports }) => ({ id: credentialId, transports })),
  });
  await saveChallenge(res, 'admin', options.challenge, user._id);
  return options;
}

export async function verifyAdminPasskey(req, res, user, response) {
  const pending = await takeChallenge(req, res, 'admin');
  if (!pending?.userId?.equals(user._id) || typeof response?.id !== 'string') return false;
  const passkey = await Passkey.findOne({ credentialId: response.id, userId: user._id });
  return Boolean(passkey) && checkAssertion(passkey, response, pending.challenge);
}

/** Không xóa được passkey nếu đó là cách đăng nhập cuối cùng. Trả về passkey đã xóa, không phải của tài khoản này thì null */
export async function removePasskey(user, id) {
  const passkey = await Passkey.findOne({ _id: id, userId: user._id });
  if (!passkey) return null;
  const others = await Passkey.countDocuments({ userId: user._id, _id: { $ne: passkey._id } });
  if (!others && !user.passwordChangedAt && !user.googleId && !user.facebookId) {
    throw new AccountError(409, 'last_login_method', 'Không thể xóa cách đăng nhập cuối cùng. Hãy đặt mật khẩu hoặc thêm phương thức khác trước.');
  }
  await Passkey.deleteOne({ _id: passkey._id });
  return passkey;
}
