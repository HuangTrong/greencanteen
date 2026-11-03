import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import Avatar from '../../components/Avatar';
import Modal from '../../components/Modal';
import { adminApi } from '../adminApi';
import { ROLE_LABELS, USER_STATUS_LABELS, formatDateTime, formatNumber } from '../format';
import { useAdminSession, useReauth } from '../session';
import { Badge, Button, Card, ConfirmDialog, ErrorState, LoadingState, PageHeader, TextField, useLoad, useNotice } from '../ui';

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b border-stone-100 py-1.5 last:border-b-0">
      <dt className="text-sm text-stone-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-semibold text-stone-800">{children}</dd>
    </div>
  );
}

/** Mã đăng ký chỉ tồn tại ở phản hồi này: đóng hộp thoại là không xem lại được */
function EnrollCodeDialog({ code, onClose }) {
  return (
    <Modal title="Mã đăng ký MFA" onClose={onClose}>
      <div className="space-y-3 p-5">
        <p className="text-sm text-stone-600">Trao mã này cho người được cấp quyền qua kênh an toàn. Mã dùng một lần, hết hạn sau 24 giờ và chỉ hiển thị lúc này.</p>
        <p data-testid="enroll-code" className="break-all rounded-xl bg-stone-100 px-3 py-2 text-center font-mono text-lg font-bold text-stone-900">
          {code}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Đã ghi lại</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function UserDetailPage() {
  const { id } = useParams();
  const { session } = useAdminSession();
  const notify = useNotice();
  const withReauth = useReauth();
  const { data: user, loading, error, reload, setData } = useLoad(() => adminApi.user(id), [id]);
  const [revealed, setRevealed] = useState(null);
  const [dialog, setDialog] = useState(null); // 'status' | 'studentId' | 'role' | 'mfa' | 'studentMfa' | 'avatar'
  const [newStudentId, setNewStudentId] = useState('');
  const [enrollCode, setEnrollCode] = useState('');

  useEffect(() => {
    document.title = 'Chi tiết tài khoản · Quản trị GreenCanteen';
    setRevealed(null);
  }, [id]);

  if (!user && loading) return <LoadingState />;
  if (!user) return <ErrorState message={error} onRetry={reload} />;

  const isSelf = user.id === session.admin?.id;
  const locked = user.status === 'locked';

  const reveal = async () => {
    try {
      setRevealed(await withReauth(() => adminApi.revealUser(id)));
    } catch (err) {
      if (!err.cancelled) notify(err.message, 'error');
    }
  };

  const changeStatus = async (reason) => {
    setData(await withReauth(() => adminApi.setUserStatus(id, locked ? 'active' : 'locked', reason)));
    notify(locked ? 'Đã mở khóa tài khoản.' : 'Đã khóa tài khoản và thu hồi mọi phiên.');
  };

  const changeStudentId = async (reason) => {
    setData(await withReauth(() => adminApi.setStudentId(id, newStudentId.trim(), reason)));
    setRevealed(null);
    setNewStudentId('');
    notify('Đã đổi mã sinh viên.');
  };

  const changeRole = async (reason) => {
    const result = await withReauth(() => adminApi.setRole(id, user.role === 'admin' ? 'user' : 'admin', reason));
    setData(result.user);
    if (result.enrollCode) setEnrollCode(result.enrollCode);
    notify(user.role === 'admin' ? 'Đã thu hồi quyền quản trị.' : 'Đã cấp quyền quản trị.');
  };

  const resetMfa = async (reason) => {
    const result = await withReauth(() => adminApi.resetUserMfa(id, reason));
    setEnrollCode(result.enrollCode);
    reload();
  };

  const resetStudentMfa = async (reason) => {
    setData(await withReauth(() => adminApi.resetStudentMfa(id, reason)));
    notify('Đã tắt xác thực hai lớp và đăng xuất tài khoản khỏi mọi thiết bị.');
  };

  const removeAvatar = async (reason) => {
    setData(await withReauth(() => adminApi.removeUserAvatar(id, reason)));
    notify('Đã gỡ ảnh đại diện.');
  };

  return (
    <>
      <PageHeader
        title={user.name}
        description={<Link to="/users" className="font-semibold text-leaf-800 underline underline-offset-2">Danh sách tài khoản</Link>}
        actions={
          <>
            <Badge tone={locked ? 'red' : 'green'}>{USER_STATUS_LABELS[user.status]}</Badge>
            {user.role === 'admin' && <Badge tone="blue">{ROLE_LABELS.admin}</Badge>}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Thông tin">
          <div className="mb-3 flex items-center gap-3">
            <Avatar src={user.avatarUrl} name={user.name} alt="Ảnh đại diện của tài khoản" className="h-16 w-16 shrink-0 text-2xl" />
            {user.avatarUrl ? (
              <Button tone="dangerOutline" onClick={() => setDialog('avatar')}>
                Gỡ ảnh đại diện
              </Button>
            ) : (
              <p className="text-sm text-stone-500">Chưa đặt ảnh đại diện.</p>
            )}
          </div>
          <dl>
            <Row label="Mã sinh viên">
              <span className="font-mono">{revealed?.studentId ?? user.studentId}</span>
            </Row>
            <Row label="Email">
              <span className="font-mono">{revealed?.email ?? user.email ?? '—'}</span>
            </Row>
            <Row label="Vai trò">{ROLE_LABELS[user.role]}</Row>
            <Row label="Phương thức đăng nhập">
              {Object.entries(user.authMethods)
                .filter(([, enabled]) => enabled)
                .map(([method]) => ({ password: 'Mật khẩu', google: 'Google', facebook: 'Facebook' })[method])
                .join(', ') || 'Chưa có'}
            </Row>
            <Row label="Tạo lúc">{formatDateTime(user.createdAt)}</Row>
            {user.role === 'admin' && <Row label="MFA">{user.mfaEnrolled ? 'Đã đăng ký' : 'Chưa đăng ký'}</Row>}
            <Row label="Xác thực hai lớp">{user.userMfaEnabled ? 'Đã bật' : 'Chưa bật'}</Row>
            <Row label="Passkey">{user.hasPasskey ? 'Đã có' : 'Chưa có'}</Row>
            {locked && (
              <>
                <Row label="Khóa lúc">{formatDateTime(user.lockedAt)}</Row>
                <Row label="Lý do khóa">{user.lockReason || '—'}</Row>
              </>
            )}
          </dl>
          {!revealed && (
            <Button tone="secondary" className="mt-3" onClick={reveal}>
              Hiện dữ liệu đầy đủ
            </Button>
          )}
          {revealed && <p className="mt-3 text-xs text-stone-500">Lượt xem này đã được ghi vào nhật ký kiểm toán.</p>}
        </Card>

        <Card title="Hoạt động">
          <dl>
            <Row label="Check-in hợp lệ">{formatNumber(user.counts.validCheckIns)}</Row>
            <Row label="Check-in không hợp lệ">{formatNumber(user.counts.invalidCheckIns)}</Row>
            <Row label="Eco-points">{formatNumber(user.ecoPoints)}</Row>
            <Row label="Lượt Gacha còn lại">{formatNumber(user.pendingGachaSpins)}</Row>
            <Row label="Phần thưởng đã nhận">{formatNumber(user.counts.rewards)}</Row>
            <Row label="Phiên đang mở">{formatNumber(user.counts.sessions)}</Row>
          </dl>
        </Card>

        <Card title="Thao tác" className="lg:col-span-2">
          {isSelf ? (
            <p className="text-sm text-stone-600">Đây là tài khoản của bạn. Các thao tác khóa và đổi quyền cần do một quản trị viên khác thực hiện.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button tone={locked ? 'secondary' : 'dangerOutline'} onClick={() => setDialog('status')}>
                {locked ? 'Mở khóa tài khoản' : 'Khóa tài khoản'}
              </Button>
              <Button tone="secondary" onClick={() => setDialog('role')}>
                {user.role === 'admin' ? 'Thu hồi quyền quản trị' : 'Cấp quyền quản trị'}
              </Button>
              {user.role === 'admin' && (
                <Button tone="secondary" onClick={() => setDialog('mfa')}>
                  Đặt lại MFA
                </Button>
              )}
              {user.userMfaEnabled && (
                <Button tone="secondary" onClick={() => setDialog('studentMfa')}>
                  Tắt xác thực hai lớp
                </Button>
              )}
            </div>
          )}
          <div className="mt-2">
            <Button tone="secondary" onClick={() => setDialog('studentId')}>
              Đổi mã sinh viên
            </Button>
          </div>
        </Card>
      </div>

      {dialog === 'status' && (
        <ConfirmDialog
          title={locked ? 'Mở khóa tài khoản' : 'Khóa tài khoản'}
          description={locked ? `Cho phép ${user.name} đăng nhập trở lại.` : `${user.name} sẽ bị đăng xuất khỏi mọi thiết bị, không đăng nhập được và rời bảng xếp hạng.`}
          confirmLabel={locked ? 'Mở khóa' : 'Khóa tài khoản'}
          tone={locked ? 'primary' : 'danger'}
          reasonLabel="Lý do"
          onConfirm={changeStatus}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'studentId' && (
        <ConfirmDialog
          title="Đổi mã sinh viên"
          description="Chỉ đổi sau khi đã xác minh thẻ sinh viên. Lịch sử check-in và mã nạp đi theo tài khoản."
          confirmLabel="Đổi mã"
          reasonLabel="Lý do"
          onConfirm={changeStudentId}
          onClose={() => setDialog(null)}
        >
          <TextField label="Mã sinh viên mới" required maxLength={40} value={newStudentId} onChange={(e) => setNewStudentId(e.target.value)} />
        </ConfirmDialog>
      )}
      {dialog === 'role' && (
        <ConfirmDialog
          title={user.role === 'admin' ? 'Thu hồi quyền quản trị' : 'Cấp quyền quản trị'}
          description={
            user.role === 'admin'
              ? 'Phiên quản trị và MFA của tài khoản này sẽ bị xóa ngay.'
              : 'Tài khoản phải có email và mật khẩu. Sau khi cấp, bạn nhận một mã đăng ký MFA dùng một lần để trao cho người này.'
          }
          confirmLabel={user.role === 'admin' ? 'Thu hồi quyền' : 'Cấp quyền'}
          reasonLabel="Lý do"
          onConfirm={changeRole}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'mfa' && (
        <ConfirmDialog
          title="Đặt lại MFA"
          description="Thiết bị xác thực cũ mất tác dụng, phiên quản trị của người này bị thu hồi. Bạn nhận một mã đăng ký mới."
          confirmLabel="Đặt lại MFA"
          reasonLabel="Lý do"
          onConfirm={resetMfa}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'studentMfa' && (
        <ConfirmDialog
          title="Tắt xác thực hai lớp"
          description="Chỉ làm khi đã đối chiếu thẻ sinh viên của người mất thiết bị. Mã xác thực và mã khôi phục cũ mất tác dụng, tài khoản bị đăng xuất khỏi mọi thiết bị và nhận thư thông báo."
          confirmLabel="Tắt xác thực hai lớp"
          tone="danger"
          reasonLabel="Lý do"
          onConfirm={resetStudentMfa}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'avatar' && (
        <ConfirmDialog
          title="Gỡ ảnh đại diện"
          description={`Ảnh của ${user.name} bị xóa hẳn và không còn hiện trên bảng xếp hạng. Tài khoản vẫn dùng bình thường và có thể đặt ảnh khác.`}
          confirmLabel="Gỡ ảnh"
          reasonLabel="Lý do"
          onConfirm={removeAvatar}
          onClose={() => setDialog(null)}
        />
      )}
      {enrollCode && <EnrollCodeDialog code={enrollCode} onClose={() => setEnrollCode('')} />}
    </>
  );
}
