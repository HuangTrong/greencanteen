import mongoose from 'mongoose';

// Bản nháp lưu được khi còn thiếu trường; câu chuyện xuất bản hoặc đã gỡ luôn phải đủ trường bắt buộc và nguồn HTTPS
function requiredUnlessDraft() {
  const story = this.$isSubdocument ? this.ownerDocument() : this;
  return story.status !== 'draft';
}

// Bài báo khoa học mà câu chuyện dựa vào — bắt buộc: chỉ hiển thị câu chuyện có nguồn kiểm chứng được
const sourceSchema = new mongoose.Schema(
  {
    title: { type: String, required: [requiredUnlessDraft, 'Cần nhập tên bài báo.'], trim: true },
    authors: {
      type: [{ type: String, trim: true }],
      validate: {
        validator(v) {
          return this.ownerDocument().status === 'draft' || (Array.isArray(v) && v.length > 0);
        },
        message: 'Cần ít nhất một tác giả',
      },
    },
    journal: { type: String, required: [requiredUnlessDraft, 'Cần nhập tên tạp chí.'], trim: true },
    year: { type: Number, required: [requiredUnlessDraft, 'Cần nhập năm xuất bản.'], min: 1900, max: 2100 },
    volume: { type: String, trim: true },
    issue: { type: String, trim: true },
    pages: { type: String, trim: true },
    doi: { type: String, trim: true },
    url: {
      type: String,
      required: [requiredUnlessDraft, 'Cần nhập URL nguồn.'],
      trim: true,
      match: [/^https:\/\//, 'URL nguồn phải dùng https://.'],
    },
  },
  { _id: false }
);

const storySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: [true, 'Cần nhập tiêu đề.'] },
    species: { type: String, required: [requiredUnlessDraft, 'Cần nhập loài được đề cập.'] },
    // Biểu tượng minh họa; ảnh là tùy chọn (giao diện tự dùng biểu tượng khi không có ảnh hoặc ảnh lỗi)
    icon: { type: String, default: '🌊' },
    imageUrl: { type: String, default: '' },
    summary: { type: String, required: [requiredUnlessDraft, 'Cần nhập tóm tắt.'] },
    // Giới hạn của nghiên cứu cần biết khi đọc (cấp quần thể, ước tính mô hình, tương quan...)
    caveat: { type: String, default: '' },
    message: { type: String, required: [requiredUnlessDraft, 'Cần nhập thông điệp.'] },
    source: { type: sourceSchema, required: [requiredUnlessDraft, 'Cần nhập nguồn nghiên cứu.'] },
    // draft: chỉ admin thấy; published: hiển thị sau check-in; archived: đã gỡ, giữ lại để xuất bản lại được
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published' },
    // seed: từ data/stories.json; admin: tạo trong khu quản trị; external: có sẵn trong DB trước khi có trường này
    origin: { type: String, enum: ['seed', 'admin', 'external'] },
    // Đặt ở mọi lần admin ghi: từ đó seed không còn đụng tới bản ghi này (services/stories.js)
    adminEditedAt: { type: Date },
    publishedAt: { type: Date },
    createdByLabel: { type: String },
    updatedByLabel: { type: String },
  },
  { timestamps: true, optimisticConcurrency: true }
);

export const Story = mongoose.model('Story', storySchema);
