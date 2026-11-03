import crypto from 'node:crypto';

/**
 * Thiết bị WebAuthn phần mềm cho test: khóa ES256 thật, chữ ký thật, nên phía server được kiểm bằng đúng thư viện xác minh chạy ở production.
 * Mỗi tham số trong `options` mô phỏng một kiểu tấn công hoặc thiết bị: origin của trang giả mạo, thiếu xác minh người dùng, bộ đếm lùi.
 */
const b64u = (value) => Buffer.from(value).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function cborHead(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(value, 1);
  return out;
}

/** CBOR tối thiểu đủ cho attestationObject và khóa COSE: số nguyên, chuỗi, byte, map */
function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([cborHead(3, Buffer.byteLength(value)), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

function coseKey(publicKey) {
  const { x, y } = publicKey.export({ format: 'jwk' });
  return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x, 'base64url')], [-3, Buffer.from(y, 'base64url')]]));
}

export class FakeAuthenticator {
  constructor({ origin, rpID }) {
    this.origin = origin;
    this.rpID = rpID;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.credentialId = crypto.randomBytes(32);
    this.counter = 0;
  }

  get id() {
    return b64u(this.credentialId);
  }

  authData(rpID, flags, attested = Buffer.alloc(0)) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), counter, attested]);
  }

  clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Trả lời navigator.credentials.create() */
  register(options, { origin = this.origin, rpID = this.rpID, userVerified = true, challenge = options.challenge } = {}) {
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey(this.publicKey)]);
    const authData = this.authData(rpID, FLAG_UP | (userVerified ? FLAG_UV : 0) | FLAG_AT, attested);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', challenge, origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Trả lời navigator.credentials.get(). Mỗi lần ký tăng bộ đếm, trừ khi test ép giá trị khác */
  authenticate(options, { origin = this.origin, rpID = this.rpID, userVerified = true, challenge = options.challenge, counter, userHandle, privateKey = this.privateKey } = {}) {
    this.counter = counter ?? this.counter + 1;
    const authData = this.authData(rpID, FLAG_UP | (userVerified ? FLAG_UV : 0));
    const clientDataJSON = this.clientData('webauthn.get', challenge, origin);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle && { userHandle: b64u(userHandle) }),
      },
    };
  }
}
