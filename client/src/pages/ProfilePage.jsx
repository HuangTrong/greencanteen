import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { useUser } from '../context/UserContext';
import { BADGE_META } from '../data/badges';
import { oauthErrorMessage, oauthSuccessMessage } from '../lib/authMessages';
import { usePageMeta } from '../lib/usePageMeta';
import ProfileGachaSection from '../components/ProfileGachaSection';
import AuthModal from '../components/AuthModal';
import QrApproveDialog from '../components/QrApproveDialog';
import AccountSection from '../components/AccountSection';
import Avatar from '../components/Avatar';
import AvatarControls from '../components/AvatarControls';

const QR_LOGIN_NOTICE =
  'Có yêu cầu đăng nhập bằng mã QR. Hãy đăng nhập trên thiết bị này trước, sau đó xác nhận yêu cầu.';

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ProfilePage() {
  usePageMeta({ title: 'Cá nhân', noindex: true });
  const { user, isLoggedIn, authLoading, logout, updateUser } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [historyState, setHistoryState] = useState({ loading: true, error: '' });
  const [authModal, setAuthModal] = useState(null); // { view, error, notice, resetToken, verifyToken } khi popup đang mở
  const [banner, setBanner] = useState(null); // { tone: 'success' | 'error', text }
  const [qrChallenge, setQrChallenge] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const modalSeq = useRef(0);

  // Mỗi lần mở có id mới → popup đang mở (vd. màn "Quên mật khẩu") được dựng lại đúng màn được yêu cầu,
  // chẳng hạn khi liên kết đặt lại mật khẩu được mở ngay trong tab này
  const showAuthModal = useCallback((options) => {
    modalSeq.current += 1;
    setAuthModal({ ...options, id: modalSeq.current });
  }, []);

  // Đọc yêu cầu gửi tới trang: kết quả Google/Facebook (?auth / ?auth_error), link trong QR (?qr),
  // liên kết đặt lại mật khẩu / xác minh trong email (#reset=..., #verify=...), nút "Đăng nhập" ở trang khác (state.openAuth)
  // — rồi xóa khỏi URL ngay để token không nằm lại trong thanh địa chỉ / lịch sử trình duyệt
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    const next = {
      auth: params.get('auth'),
      authError: params.get('auth_error'),
      provider: params.get('provider'),
      qr: params.get('qr'),
      resetToken: hashParams.get('reset'),
      verifyToken: hashParams.get('verify'),
      openAuth: Boolean(location.state?.openAuth),
    };
    if (!next.auth && !next.authError && !next.qr && !next.resetToken && !next.verifyToken && !next.openAuth) return;
    setIncoming(next);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.search, location.hash, location.state, location.pathname, navigate]);

  // Xử lý yêu cầu khi đã biết trạng thái đăng nhập
  useEffect(() => {
    if (authLoading || !incoming) return;
    setIncoming(null);
    if (incoming.resetToken) {
      showAuthModal({ view: 'reset', resetToken: incoming.resetToken });
      return;
    }
    if (incoming.verifyToken) {
      showAuthModal({ view: 'verify-email', verifyToken: incoming.verifyToken });
      return;
    }
    if (incoming.qr) setQrChallenge(incoming.qr);

    if (incoming.auth === 'complete_signup') {
      showAuthModal({ view: 'complete-signup' });
      return;
    }
    if (incoming.auth === 'mfa_required') {
      showAuthModal({ view: 'mfa' });
      return;
    }
    if (incoming.auth === 'success' || incoming.auth === 'linked') {
      // Chỉ báo thành công khi server thật sự có phiên — tham số URL ai cũng tự gõ được
      if (!isLoggedIn) {
        showAuthModal({ view: 'methods', error: oauthErrorMessage('oauth_failed', incoming.provider) });
        return;
      }
      setBanner({ tone: 'success', text: oauthSuccessMessage(incoming.auth, incoming.provider) });
    }
    if (incoming.authError) {
      const text = oauthErrorMessage(incoming.authError, incoming.provider);
      if (isLoggedIn) {
        setBanner({ tone: 'error', text });
      } else {
        showAuthModal({ view: 'methods', error: text });
        return;
      }
    }
    if (!isLoggedIn && (incoming.openAuth || incoming.qr)) {
      showAuthModal({ view: 'methods', notice: incoming.qr ? QR_LOGIN_NOTICE : '' });
    }
  }, [authLoading, incoming, isLoggedIn, showAuthModal]);

  const loadHistory = useCallback(() => {
    setHistoryState({ loading: true, error: '' });
    api
      .history()
      .then((r) => {
        setHistory(r.history || []);
        setHistoryState({ loading: false, error: '' });
      })
      .catch((err) => {
        setHistory([]);
        setHistoryState({ loading: false, error: err.message || 'Không tải được lịch sử.' });
      });
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      setHistory([]);
      setHistoryState({ loading: false, error: '' });
      return;
    }
    loadHistory();
  }, [isLoggedIn, user?.id, loadHistory]);

  const openAuth = () => showAuthModal({ view: 'methods', notice: qrChallenge ? QR_LOGIN_NOTICE : '' });

  let content;
  if (authLoading) {
    content = <p className="text-sm text-stone-500">Đang tải hồ sơ...</p>;
  } else if (!isLoggedIn) {
    content = (
      <div className="animate-fade-up rounded-3xl border border-leaf-100 bg-white p-6 text-center shadow-sm">
        <p className="text-4xl">👤</p>
        <p className="mt-2 font-bold text-stone-700">Chưa có hồ sơ cá nhân</p>
        <p className="mt-1 text-sm text-stone-500">
          Đăng nhập hoặc tạo tài khoản để check-in, tích Eco-points và nhận lượt quay Gacha.
        </p>
        {qrChallenge && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            {QR_LOGIN_NOTICE}
          </p>
        )}
        <button
          type="button"
          onClick={openAuth}
          className="mt-4 w-full rounded-xl bg-leaf-600 py-3 text-sm font-bold text-white shadow-md transition hover:bg-leaf-700"
        >
          Đăng nhập / Đăng ký
        </button>
      </div>
    );
  } else {
    const badges = user.badges || [];
    content = (
      <div className="space-y-4">
        <div className="rounded-3xl bg-gradient-to-br from-leaf-600 to-emerald-700 p-5 text-white shadow-lg">
          <div className="flex items-center gap-4">
            <Avatar
              src={user.avatarUrl}
              name={user.name}
              alt="Ảnh đại diện"
              className="h-20 w-20 shrink-0 border-[3px] border-white/90 text-3xl shadow-md"
            />
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase text-leaf-200">Hồ sơ sinh thái</p>
              <h2 className="break-words text-2xl font-extrabold">{user.name}</h2>
              <p className="break-words text-sm text-leaf-100">MSSV {user.studentId}</p>
            </div>
          </div>
          <AvatarControls user={user} onUserChange={updateUser} />
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl bg-white/15 p-2">
              <p className="text-xl font-extrabold">{user.ecoPoints}</p>
              <p className="text-[10px] font-bold uppercase">Eco-points</p>
            </div>
            <div className="rounded-xl bg-white/15 p-2">
              <p className="text-xl font-extrabold">{user.totalCheckIns}</p>
              <p className="text-[10px] font-bold uppercase">Check-in</p>
            </div>
            <div className="rounded-xl bg-white/15 p-2">
              <p className="text-lg font-extrabold">{user.plasticSavedGrams}g</p>
              <p className="text-[10px] font-bold uppercase">Nhựa tránh</p>
            </div>
            <div className="rounded-xl bg-white/15 p-2">
              <p className="text-lg font-extrabold">{user.co2SavedGrams || 0}g</p>
              <p className="text-[10px] font-bold uppercase">CO₂ ước tính</p>
            </div>
          </div>
        </div>

        <section>
          <h3 className="mb-2 text-sm font-extrabold text-leaf-800">Huy hiệu</h3>
          {badges.length === 0 ? (
            <p className="text-sm text-stone-500">Check-in lần đầu để nhận huy hiệu 🌱</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {badges.map((id) => {
                const meta = BADGE_META[id] || { label: id, emoji: '🏅' };
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-leaf-200 bg-white px-3 py-1 text-xs font-bold text-leaf-800"
                  >
                    {meta.emoji} {meta.label}
                  </span>
                );
              })}
            </div>
          )}
        </section>

        <ProfileGachaSection
          key={user.id}
          pendingSpins={user.pendingGachaSpins}
          onSpinsChange={(n) => updateUser({ pendingGachaSpins: n })}
        />

        <section>
          <h3 className="mb-2 text-sm font-extrabold text-leaf-800">Lịch sử check-in</h3>
          {historyState.loading ? (
            <p className="text-sm text-stone-500">Đang tải...</p>
          ) : historyState.error ? (
            <div role="alert" className="flex items-center gap-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              <span className="flex-1">{historyState.error}</span>
              <button type="button" onClick={loadHistory} className="shrink-0 font-bold underline">
                Thử lại
              </button>
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-stone-500">Chưa có lịch sử. Hãy check-in tại căn tin!</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li
                  key={h._id || h.createdAt}
                  className="rounded-xl border border-leaf-50 bg-white px-3 py-2 text-sm shadow-sm"
                >
                  <div className="flex justify-between gap-2 font-semibold text-stone-800">
                    <span>+{h.pointsEarned} điểm</span>
                    <span className="text-xs text-stone-400">{formatDate(h.createdAt)}</span>
                  </div>
                  {h.categoryLabel && (
                    <p className="text-xs font-semibold text-leaf-700">
                      {h.categoryLabel}
                      {typeof h.confidence === 'number' && ` · ${Math.round(h.confidence * 100)}%`}
                      {h.verification === 'simulated' && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                          Mô phỏng
                        </span>
                      )}
                    </p>
                  )}
                  <p className="text-xs text-stone-500">{h.aiReason || 'Check-in hợp lệ'}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <AccountSection
          user={user}
          onUserChange={(u) => updateUser(u)}
          onLogout={() => {
            setBanner(null);
            return logout();
          }}
        />
      </div>
    );
  }

  // Popup nằm ngoài phần nội dung đổi theo trạng thái đăng nhập → không bị unmount khi vừa đăng nhập
  // xong (popup còn hiện thông báo thành công trước khi tự đóng)
  return (
    <>
      <div className="space-y-4">
        {banner && (
          <div
            role={banner.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm font-semibold ${
              banner.tone === 'error' ? 'bg-red-50 text-red-700' : 'bg-leaf-100 text-leaf-900'
            }`}
          >
            <span className="flex-1">{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              aria-label="Ẩn thông báo"
              className="text-lg leading-none"
            >
              ×
            </button>
          </div>
        )}
        {content}
      </div>
      {authModal && (
        <AuthModal
          key={authModal.id}
          initialView={authModal.view}
          initialError={authModal.error}
          notice={authModal.notice}
          resetToken={authModal.resetToken}
          verifyToken={authModal.verifyToken}
          onClose={() => setAuthModal(null)}
        />
      )}
      {qrChallenge && isLoggedIn && !authModal && (
        <QrApproveDialog challengeId={qrChallenge} onClose={() => setQrChallenge(null)} />
      )}
    </>
  );
}
