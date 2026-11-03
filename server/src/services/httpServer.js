import http from 'node:http';

// Mặc định của Node (60 và 300 giây) cho phép giữ rất nhiều kết nối gửi nhỏ giọt rất lâu. 120 giây vẫn đủ tải ảnh tối đa qua mạng di động chậm
const LIMITS = { headersTimeout: 20_000, requestTimeout: 120_000, connectionsCheckingInterval: 5_000 };

export const createHttpServer = (app, limits = {}) => http.createServer({ ...LIMITS, ...limits }, app);
