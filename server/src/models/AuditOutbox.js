import mongoose from 'mongoose';

/**
 * SEC-07: dấu vết ghi TRƯỚC khi một thao tác ghi của quản trị viên chạy (ai, thao tác gì, lúc nào). Thao tác xong thì dấu vết được
 * chuyển thành một dòng AuditLog cùng _id rồi xóa. Dấu vết còn lại nghĩa là bước ghi nhật ký cuối thất bại (có result) hoặc server
 * dừng giữa thao tác (không có result): services/audit.js flushAuditOutbox chuyển nốt khi khởi động và định kỳ.
 */
const auditOutboxSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    // Không có = chưa biết thao tác đã xong hay chưa
    result: { type: String, enum: ['success', 'failure', 'denied'] },
    reason: { type: String, default: '' },
    actorType: { type: String, enum: ['admin', 'cli', 'user', 'anonymous'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorLabel: { type: String, default: '' },
    targetType: String,
    targetId: String,
    targetLabel: String,
    meta: mongoose.Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

auditOutboxSchema.index({ createdAt: 1 });

export const AuditOutbox = mongoose.model('AuditOutbox', auditOutboxSchema);
