import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { JPEG_QUALITY, prepareUpload, targetSize } from '../lib/imageCompress';
import { useUser } from '../context/UserContext';
import { usePageMeta } from '../lib/usePageMeta';
import CheckInSuccessModal from '../components/CheckInSuccessModal';

const STEPS = { idle: 'idle', analyzing: 'analyzing', success: 'success', rejected: 'rejected', error: 'error' };

const percent = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '');

export default function CheckInPage() {
  usePageMeta({ title: 'Check-in', noindex: true });
  const { isLoggedIn, authLoading, updateUser } = useUser();
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const previewUrlRef = useRef(null);
  // Mỗi lần chọn ảnh / bật camera / chụp lại tăng số này: kết quả nén của lần chọn cũ về muộn thì bỏ qua
  const pickToken = useRef(0);

  const [preview, setPreview] = useState(null);
  const [file, setFile] = useState(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [preparing, setPreparing] = useState(false); // đang nén ảnh vừa chọn
  const [step, setStep] = useState(STEPS.idle);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null); // { classification, story, points, gacha }
  const [modalOpen, setModalOpen] = useState(false);
  // Server cho biết check-in có khả dụng không: local | simulated | unavailable (+ engine: classifier — bộ phân loại ONNX trên CPU)
  const [service, setService] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let cancelled = false;
    api
      .checkInStatus()
      .then((data) => {
        if (!cancelled) setService({ loading: false, error: '', data });
      })
      .catch((err) => {
        if (!cancelled) setService({ loading: false, error: err.message || 'Không kiểm tra được máy chủ.', data: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Gắn stream vào <video> sau khi element được mount (cameraOn = true)
  useEffect(() => {
    if (cameraOn && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraOn]);

  // Dừng camera + giải phóng preview khi rời trang; ảnh đang nén dở thì bỏ kết quả
  useEffect(() => {
    return () => {
      pickToken.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  // Phiên hết hạn giữa chừng → tắt camera vì trang chuyển sang thông báo cần đăng nhập
  useEffect(() => {
    if (isLoggedIn) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, [isLoggedIn]);

  const setPreviewUrl = (url) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreview(url);
  };

  if (authLoading) {
    return <p className="text-sm text-stone-500">Đang tải...</p>;
  }

  if (!isLoggedIn) {
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5 text-center">
        <p className="font-bold text-amber-900">Bạn cần đăng nhập trước khi check-in</p>
        <Link
          to="/profile"
          state={{ openAuth: true }}
          className="mt-3 inline-block text-sm font-bold text-leaf-700 underline"
        >
          Đăng nhập tại trang Cá nhân
        </Link>
      </div>
    );
  }

  const mode = service.data?.mode;
  const unavailable = mode === 'unavailable';
  const maxBytes = service.data?.maxImageBytes;

  const resetResult = () => {
    setStep(STEPS.idle);
    setMessage('');
    setResult(null);
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  };

  const cancelPendingPick = () => {
    pickToken.current += 1;
    setPreparing(false);
  };

  const startCamera = async () => {
    try {
      stopCamera();
      cancelPendingPick();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setPreviewUrl(null);
      setFile(null);
      resetResult();
      // Bật camera trước — stream sẽ được gắn vào <video> qua useEffect
      setCameraOn(true);
    } catch {
      setStep(STEPS.error);
      setMessage('Không mở được camera. Hãy cho phép truy cập camera hoặc tải ảnh từ thư viện.');
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setStep(STEPS.error);
      setMessage('Camera chưa sẵn sàng. Đợi một giây rồi chụp lại.');
      return;
    }
    // Thu nhỏ về cạnh dài tối đa 2048 px như ảnh chọn từ thư viện (camera 4K cho ảnh vài MB, quá sức proxy và mạng di động)
    const { width, height } = targetSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setStep(STEPS.error);
          setMessage('Không chụp được ảnh. Hãy thử lại hoặc tải ảnh lên.');
          return;
        }
        setFile(new File([blob], 'capture.jpg', { type: 'image/jpeg' }));
        setPreviewUrl(URL.createObjectURL(blob));
        resetResult();
        stopCamera();
      },
      'image/jpeg',
      JPEG_QUALITY
    );
  };

  /** Kiểm tra sơ bộ để báo lỗi sớm — server vẫn kiểm tra lại nội dung tệp */
  const typeProblem = (f) => {
    if (!f.size) return 'Ảnh rỗng. Vui lòng chọn ảnh khác.';
    if (f.type && !f.type.startsWith('image/')) return 'Tệp đã chọn không phải ảnh.';
    return '';
  };
  // Giới hạn kích thước áp cho tệp sẽ gửi đi (sau khi nén), không phải ảnh gốc
  const sizeProblem = (f) =>
    maxBytes && f.size > maxBytes
      ? `Ảnh quá lớn (${(f.size / 1048576).toFixed(1)}MB, tối đa ${Math.round(maxBytes / 1048576)}MB). Hãy chụp lại hoặc chọn ảnh nhỏ hơn.`
      : '';

  const showPickError = (problem) => {
    setFile(null);
    setPreviewUrl(null);
    setStep(STEPS.error);
    setMessage(problem);
  };

  const onPickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // chọn lại cùng một tệp vẫn kích hoạt onChange
    if (!f) return;
    stopCamera();
    resetResult();
    const token = ++pickToken.current;
    const problem = typeProblem(f);
    if (problem) {
      setPreparing(false);
      showPickError(problem);
      return;
    }
    // Ảnh lớn được thu nhỏ / nén JPEG để qua được proxy của nơi đặt giao diện và tải nhanh; không nén được thì giữ ảnh gốc
    setPreparing(true);
    setFile(null);
    setPreviewUrl(null);
    const prepared = await prepareUpload(f);
    if (token !== pickToken.current) return; // đã chọn ảnh khác hoặc bật camera trong lúc nén
    setPreparing(false);
    const tooLarge = sizeProblem(prepared.file);
    if (tooLarge) {
      showPickError(tooLarge);
      return;
    }
    setFile(prepared.file);
    setPreviewUrl(URL.createObjectURL(prepared.file));
  };

  const submitCheckIn = async () => {
    if (!file) {
      setStep(STEPS.error);
      setMessage('Hãy chụp hoặc chọn ảnh bình/ly cá nhân.');
      return;
    }
    setStep(STEPS.analyzing);
    setResult(null);
    setMessage(mode === 'simulated' ? 'Đang xử lý (chế độ mô phỏng)...' : 'Máy chủ đang nhận diện ảnh...');
    try {
      // Phiên hết hạn → api báo 401 cho UserContext, trang tự chuyển sang yêu cầu đăng nhập
      const r = await api.checkIn(file);
      updateUser(r.user);
      setResult({
        classification: r.classification,
        story: r.story,
        points: r.pointsEarned,
        gacha: r.gachaSpinGranted ?? 1,
      });
      setStep(STEPS.success);
      setMessage(r.reason);
      setModalOpen(true);
    } catch (err) {
      const classification = err.payload?.classification || null;
      setResult(classification ? { classification } : null);
      setStep(err.code === 'container_not_accepted' ? STEPS.rejected : STEPS.error);
      setMessage(err.message || 'Check-in không thành công.');
    }
  };

  const reset = () => {
    cancelPendingPick();
    setPreviewUrl(null);
    setFile(null);
    resetResult();
    stopCamera();
  };

  const classification = result?.classification;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-extrabold text-leaf-800">Check-in thông minh</h2>
        <p className="text-sm text-stone-500">
          Chụp bình nước hoặc ly/cốc cá nhân tại quầy căn tin. Thành công: +Eco-points, một câu chuyện từ nghiên cứu khoa
          học và 1 lượt quay thưởng tri ân (quà là móc khóa, trúng hay không do may mắn).
        </p>
      </div>

      {unavailable && (
        <div role="alert" className="rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-700">
          <p className="font-bold">Check-in bằng ảnh tạm thời chưa khả dụng</p>
          <p className="mt-1 text-xs">Máy chủ chưa sẵn sàng nhận diện ảnh. Vui lòng báo quản trị viên.</p>
        </div>
      )}
      {mode === 'simulated' && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
          Chế độ mô phỏng (chỉ dành cho phát triển): kết quả là giá trị cố định do máy chủ cấu hình, không phải AI nhận
          diện ảnh thật.
        </div>
      )}
      {service.error && (
        <p className="rounded-xl bg-stone-100 px-4 py-2 text-xs text-stone-600">
          Không kiểm tra được trạng thái nhận diện ({service.error}). Bạn vẫn có thể thử check-in.
        </p>
      )}
      {mode === 'local' && (
        <p className="text-xs text-stone-500">
          Ảnh được nhận diện ngay trên máy chủ GreenCanteen, không gửi cho dịch vụ AI bên ngoài. Chỉ bình/ly cá nhân với độ tin
          cậy từ {percent(service.data.threshold)} trở lên mới được tính điểm.
          {service.data.cooldownMinutes > 0 &&
            ` Mỗi lượt được thưởng cách nhau ít nhất ${service.data.cooldownMinutes} phút.`}
          {service.data.dailyMax > 0 && ` Mỗi ngày được thưởng tối đa ${service.data.dailyMax} lượt.`}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-leaf-100 bg-stone-900 shadow-inner">
        {cameraOn ? (
          <video ref={videoRef} className="aspect-[4/3] w-full object-cover" playsInline muted />
        ) : preview ? (
          <img src={preview} alt="Xem trước ảnh check-in" className="aspect-[4/3] w-full object-cover" />
        ) : (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-stone-800 text-stone-300">
            <span className="text-4xl">🥤</span>
            <p className="text-sm font-semibold">Camera hoặc tải ảnh lên</p>
          </div>
        )}
      </div>

      {step === STEPS.analyzing && (
        <div role="status" className="flex items-center gap-3 rounded-xl bg-leaf-50 px-4 py-3">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-leaf-600 border-t-transparent" />
          <p className="text-sm font-bold text-leaf-800">{message}</p>
        </div>
      )}

      {(step === STEPS.rejected || step === STEPS.error) && (
        <div
          role="alert"
          className={`space-y-1 rounded-xl px-4 py-3 text-sm ${
            step === STEPS.rejected ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'
          }`}
        >
          <p className="font-semibold">{message}</p>
          {classification?.category && <ClassificationDetails classification={classification} />}
        </div>
      )}

      {step === STEPS.success && !modalOpen && (
        <div role="status" className="animate-pop-in space-y-1 rounded-xl bg-leaf-100 px-4 py-3 text-sm text-leaf-900">
          <p className="font-bold">Check-in thành công! +{result?.points} Eco-points</p>
          {classification && <ClassificationDetails classification={classification} />}
          {result?.story && (
            <button type="button" onClick={() => setModalOpen(true)} className="text-xs font-bold underline">
              Xem lại câu chuyện
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {!cameraOn ? (
          <button
            type="button"
            onClick={startCamera}
            disabled={step === STEPS.analyzing}
            className="rounded-xl border border-leaf-200 bg-white py-3 text-sm font-bold text-leaf-800 disabled:opacity-50"
          >
            Mở camera
          </button>
        ) : (
          <button type="button" onClick={capturePhoto} className="rounded-xl bg-leaf-600 py-3 text-sm font-bold text-white">
            Chụp ảnh
          </button>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={step === STEPS.analyzing}
          className="rounded-xl border border-leaf-200 bg-white py-3 text-sm font-bold text-leaf-800 disabled:opacity-50"
        >
          Tải ảnh lên
        </button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickFile} />
      </div>

      <button
        type="button"
        disabled={step === STEPS.analyzing || preparing || unavailable || service.loading}
        onClick={submitCheckIn}
        className="w-full rounded-2xl bg-gradient-to-r from-leaf-600 to-leaf-500 py-4 text-base font-extrabold text-white shadow-lg disabled:opacity-50"
      >
        {step === STEPS.analyzing ? 'Đang xử lý...' : preparing ? 'Đang chuẩn bị ảnh...' : 'Check-in ngay'}
      </button>

      {(preview || step !== STEPS.idle) && step !== STEPS.analyzing && (
        <button type="button" onClick={reset} className="w-full text-sm font-semibold text-stone-500">
          Chụp lại
        </button>
      )}

      <CheckInSuccessModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        story={result?.story}
        classification={classification}
        pointsEarned={result?.points}
        gachaSpinGranted={result?.gacha}
        onGachaComplete={({ pendingGachaSpins }) => updateUser({ pendingGachaSpins })}
      />
    </div>
  );
}

function ClassificationDetails({ classification }) {
  return (
    <div className="text-xs">
      <p>
        {classification.simulated ? (
          <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">MÔ PHỎNG</span>
        ) : (
          <span className="font-bold">Kết quả nhận diện: </span>
        )}
        {classification.categoryLabel}
        {typeof classification.confidence === 'number' &&
          ` · độ tin cậy ${percent(classification.confidence)} (ngưỡng ${percent(classification.threshold)})`}
      </p>
      {classification.reason && <p className="opacity-80">{classification.reason}</p>}
    </div>
  );
}
