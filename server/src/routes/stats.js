import { Router } from 'express';
import { avatarUrl } from '../services/accounts.js';
import { cachedPublicStats, getSchoolStats } from '../services/stats.js';
import { User } from '../models/User.js';
import { CheckIn } from '../models/CheckIn.js';

const router = Router();

router.get('/school', async (_req, res) => {
  try {
    res.json(await cachedPublicStats('school', getSchoolStats));
  } catch (e) {
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

async function loadLeaderboard(period) {
  const since = new Date();
  if (period === 'month') {
    since.setDate(since.getDate() - 30);
  } else {
    since.setDate(since.getDate() - 7);
  }

  // Tài khoản bị khóa không còn xuất hiện trên bảng xếp hạng công khai
  const locked = await User.find({ status: 'locked' }).distinct('_id');
  const agg = await CheckIn.aggregate([
    { $match: { valid: true, createdAt: { $gte: since }, userId: { $nin: locked } } },
    {
      $group: {
        _id: '$userId',
        checkIns: { $sum: 1 },
        points: { $sum: '$pointsEarned' },
      },
    },
    { $sort: { checkIns: -1, points: -1 } },
    { $limit: 20 },
  ]);

  const userIds = agg.map((a) => a._id);
  const users = await User.find({ _id: { $in: userIds } }).select('name avatarId').lean();
  const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

  // Bảng xếp hạng công khai: chỉ tên hiển thị, ảnh đại diện và số liệu — không lộ mã sinh viên hay khoa/lớp
  const personal = agg.map((a, i) => {
    const u = userMap[a._id.toString()];
    return {
      rank: i + 1,
      name: u?.name || 'Ẩn danh',
      avatarUrl: avatarUrl(u?.avatarId),
      checkIns: a.checkIns,
      points: a.points,
    };
  });

  // Đã bỏ xếp hạng theo Khoa/Viện; giữ khóa rỗng để bản client cũ còn trong cache PWA không lỗi
  return { period, personal, byDepartment: [] };
}

router.get('/leaderboard', async (req, res) => {
  try {
    const period = req.query.period === 'month' ? 'month' : 'week';
    res.json(await cachedPublicStats(`leaderboard:${period}`, () => loadLeaderboard(period)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

export default router;
