import mongoose from 'mongoose';

// Nhật ký kiểm toán chỉ ghi thêm: không có API sửa/xóa và model từ chối mọi thao tác sửa/xóa.
// Ai có quyền ghi trực tiếp vào MongoDB vẫn sửa được — xem docs/admin/README.md về tài khoản DB và sao lưu ngoài.
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, immutable: true },
    result: { type: String, enum: ['success', 'failure', 'denied'], required: true, immutable: true },
    reason: { type: String, default: '', immutable: true },
    actorType: { type: String, enum: ['admin', 'cli', 'user', 'anonymous'], required: true, immutable: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    actorLabel: { type: String, default: '', immutable: true },
    targetType: { type: String, immutable: true },
    targetId: { type: String, immutable: true },
    targetLabel: { type: String, immutable: true },
    meta: { type: mongoose.Schema.Types.Mixed, immutable: true },
    ip: { type: String, immutable: true },
    userAgent: { type: String, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

function rejectChange() {
  throw new Error('Nhật ký kiểm toán chỉ được ghi thêm.');
}

auditLogSchema.pre('save', function rejectResave() {
  if (!this.isNew) rejectChange();
});
for (const operation of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
]) {
  auditLogSchema.pre(operation, { query: true, document: true }, rejectChange);
}

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
