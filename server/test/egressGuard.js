// Chặn mọi kết nối rời khỏi máy (loopback) trong tiến trình test ở tầng net.Socket và DNS: fetch (undici), http/https, tls, SMTP
// (nodemailer tự phân giải DNS trước khi kết nối), clamd... đều đi qua đây, không chỉ globalThis.fetch. Kết nối bị chặn không phân giải
// DNS, không gửi byte nào: socket nhận lỗi EGRESS_BLOCKED như khi máy đích từ chối, để test kiểm được cả cách server xử lý lỗi phụ thuộc.
import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
const DNS_FUNCTIONS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse'];

export const isLoopbackHost = (host) =>
  LOOPBACK_NAMES.has(String(host).toLowerCase()) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^::ffff:127\./i.test(host);

/** Đích của một lần gọi Socket#connect: { host, port } hoặc null nếu là IPC (đường dẫn tệp / named pipe) */
function destination(args) {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (first !== null && typeof first === 'object') {
    if (first.path) return null;
    return { host: String(first.host ?? 'localhost'), port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return { host: typeof second === 'string' ? second : 'localhost', port: first };
}

const blockedError = (what) => Object.assign(new Error(`Chặn kết nối ra ngoài trong test: ${what}`), { code: 'EGRESS_BLOCKED' });

/**
 * Bật chặn. Trả về { attempts, restore }: attempts ghi mọi lần thử ra ngoài ("host:port" hoặc "dns:tên"), restore() trả lại hành vi gốc.
 * Gọi trong before() của tệp test; mỗi tệp chạy trong tiến trình riêng nên không ảnh hưởng tệp khác.
 */
export function blockNonLoopbackEgress() {
  const attempts = [];
  const restorers = [];

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = destination(args);
    if (!target || isLoopbackHost(target.host)) return originalConnect.apply(this, args);
    attempts.push(`${target.host}:${target.port}`);
    process.nextTick(() => this.destroy(blockedError(`${target.host}:${target.port}`)));
    return this;
  };
  restorers.push(() => {
    net.Socket.prototype.connect = originalConnect;
  });

  for (const name of DNS_FUNCTIONS) {
    const callbackStyle = dns[name];
    if (typeof callbackStyle === 'function') {
      dns[name] = function guardedDns(host, ...rest) {
        if (isLoopbackHost(host)) return callbackStyle.call(this, host, ...rest);
        attempts.push(`dns:${host}`);
        const callback = rest.reverse().find((arg) => typeof arg === 'function');
        if (callback) process.nextTick(() => callback(blockedError(`dns:${host}`)));
        return undefined;
      };
      restorers.push(() => {
        dns[name] = callbackStyle;
      });
    }
    const promiseStyle = dns.promises[name];
    if (typeof promiseStyle === 'function') {
      dns.promises[name] = function guardedDnsPromise(host, ...rest) {
        if (isLoopbackHost(host)) return promiseStyle.call(this, host, ...rest);
        attempts.push(`dns:${host}`);
        return Promise.reject(blockedError(`dns:${host}`));
      };
      restorers.push(() => {
        dns.promises[name] = promiseStyle;
      });
    }
  }

  return {
    attempts,
    restore() {
      for (const restore of restorers.splice(0)) restore();
    },
  };
}
