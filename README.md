# GreenCanteen

Nền tảng web (PWA) giúp học sinh/sinh viên **check-in** việc dùng bình/ly nước cá nhân tại căn tin thay cho ly nhựa dùng một lần.
Sinh viên chụp ảnh bình/ly, **máy chủ của trường** tự nhận diện ảnh (không gửi cho dịch vụ AI cloud), hợp lệ thì được cộng Eco-points và một lượt quay thưởng tri ân (quà là móc khóa, trúng hay không do may mắn).

README này hướng dẫn **cài đặt, chạy, sử dụng và triển khai**. Giải thích từng biến môi trường nằm trong [`server/.env.example`](server/.env.example).

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Yêu cầu](#2-yêu-cầu)
3. [Cài đặt](#3-cài-đặt)
4. [Chạy thử nhanh (không cần MongoDB)](#4-chạy-thử-nhanh-không-cần-mongodb)
5. [Chạy môi trường phát triển](#5-chạy-môi-trường-phát-triển)
6. [Cấu hình `server/.env`](#6-cấu-hình-serverenv)
7. [Hướng dẫn sử dụng](#7-hướng-dẫn-sử-dụng)
8. [Triển khai (production)](#8-triển-khai-production)
9. [Kiểm thử](#9-kiểm-thử)
10. [Xử lý sự cố](#10-xử-lý-sự-cố)
11. [Giới hạn hiện tại](#11-giới-hạn-hiện-tại)

## 1. Tổng quan

```
Trình duyệt (React + Vite + Tailwind, PWA)
        │  HTTPS / REST — phiên đăng nhập bằng cookie httpOnly
        ▼
Node.js + Express API  (cổng 3001)
        ├── MongoDB                      lưu tài khoản, check-in, quay thưởng, câu chuyện, nhật ký kiểm toán...
        ├── Google / Facebook OAuth      tùy chọn
        ├── SMTP                         xác minh đăng ký, quên mật khẩu (tùy chọn nhưng cần để đăng ký bằng email)
        ├── ClamAV (clamd)               quét mã độc ảnh tải lên (tùy chọn, nên có ở production)
        └── Nhận diện ảnh check-in TẠI MÁY CHỦ
              └── Bộ phân loại ONNX (engine `classifier`, onnxruntime-node trong tiến trình Node, chỉ dùng CPU, ngoại tuyến)
```

**Cấu trúc thư mục**

```
greencanteen/
├── client/    Giao diện React + Vite (trang sinh viên và khu quản trị /admin)
├── server/    API Express + Mongoose
│   ├── src/        mã nguồn (routes, services, models, data/stories.json)
│   ├── scripts/    công cụ: dev server, tải/kiểm/đánh giá mô hình nhận diện
│   ├── models/     mô hình nhận diện ảnh (ONNX) tải về bằng npm run vision:download (không đưa vào git)
│   └── uploads/    thư mục tạm cho ảnh đang xử lý
├── tools/     script cài đặt (setup.mjs), công cụ đo độ phủ C2 dùng cho test
├── setup.cmd  cài đặt tự động trên Windows
└── package.json   lệnh tiện ích chạy từ thư mục gốc
```

**Tính năng chính:** thống kê toàn trường, đăng nhập (email + mật khẩu, Google, Facebook, mã QR, passkey, xác thực hai lớp),
check-in bằng camera/ảnh, quay thưởng tri ân (móc khóa), bảng xếp hạng tuần/tháng, popup câu chuyện khoa học có nguồn, khu quản trị `/admin` (MFA bắt buộc).

## 2. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Node.js | **20 trở lên** (kèm npm), nên dùng bản LTS từ [nodejs.org](https://nodejs.org) |
| Git | Để clone dự án từ GitHub ([git-scm.com](https://git-scm.com)). Không có Git thì dùng nút "Download ZIP" trên GitHub |
| Trình duyệt | Chrome hoặc Edge: mở trang web, chạy test E2E |
| Ứng dụng xác thực | Google Authenticator, Microsoft Authenticator... trên điện thoại, để bật MFA khi vào khu quản trị |
| MongoDB | Bản cài local (trên Windows, `npm run setup` tự cài) hoặc MongoDB Atlas. Khi phát triển có thể dùng DB in-memory (xem [mục 4](#4-chạy-thử-nhanh-không-cần-mongodb)) |
| Nhận diện ảnh | Bộ phân loại ONNX (engine `classifier`, [mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)) chạy trong tiến trình server, chỉ dùng CPU, không cần GPU: 8–22 MB đĩa, ~80–90 MB RAM thêm |
| Hệ điều hành | Windows, macOS, Linux (máy chủ production khuyến nghị Linux) |

## 3. Cài đặt

### Cài tự động

Chỉ cần cài sẵn [Node.js](https://nodejs.org) 20 trở lên. Trên Windows, bấm đúp `setup.cmd` ở thư mục gốc, hoặc chạy:

```bash
npm run setup
```

| Bước | Việc làm |
|---|---|
| Thư viện | `npm ci` cho `server` và `client` nếu chưa có `node_modules` |
| `server/.env` | Tạo từ `.env.example` nếu chưa có |
| Mô hình nhận diện ảnh | Tải bộ phân loại ONNX (~8 MB) vào `server/models/`, kiểm mã băm |
| MongoDB (chỉ Windows) | Tải bản 8.0.34 (~808 MB, ghim mã băm), cài vào `D:\MongoDB` (không có ổ D thì vào thư mục người dùng), chỉ nghe `127.0.0.1`, tạo tài khoản, ghi `MONGODB_URI`. Không cần quyền Administrator, không cài dịch vụ Windows |
| Khóa quản trị | Sinh `ADMIN_MFA_KEY` nếu chưa có |

Mật khẩu và khóa chỉ ghi vào tệp, không in ra màn hình: chuỗi kết nối ứng dụng và `ADMIN_MFA_KEY` ở `server/.env`, chuỗi kết nối root ở `mongodb-admin.txt` trong thư mục cài MongoDB. Cuối cùng script in danh sách việc bạn còn phải tự làm.

Tùy chọn: `--mongo-dir <thư mục>`, `--mongo-port <cổng>`, `--skip-mongodb` (dùng MongoDB có sẵn hoặc Atlas). Truyền qua npm: `npm run setup -- --skip-mongodb`.

### Cài thủ công

Từ thư mục gốc dự án (`greencanteen/`):

```bash
# Cài thư viện cho cả server và client
npm run install:all
```

Tương đương `npm install --prefix server && npm install --prefix client`.

Tạo tệp cấu hình cho server:

```bash
# macOS / Linux / Git Bash
cp server/.env.example server/.env
```

```powershell
# Windows PowerShell
Copy-Item server\.env.example server\.env
```

Tải mô hình nhận diện ảnh (một lần, ~8 MB, vào `server/models/`, có kiểm mã băm):

```bash
cd server
npm run vision:download
npm run vision:verify     # kiểm lại mã băm
```

Sau bước này server **không** tự tải gì từ Internet khi chạy.

> Linux x64: `onnxruntime-node` mặc định tải thêm thư viện CUDA/TensorRT lúc `npm install`. Server chỉ dùng CPU nên có thể bỏ:
> `ONNXRUNTIME_NODE_INSTALL=skip npm install`.



**Chạy trên máy khác.** Cài trước Node.js và Git ([mục 2](#2-yêu-cầu)), rồi:

```bash
git clone https://github.com/<tai-khoan>/greencanteen.git
cd greencanteen
npm run setup
```

Trên Windows có thể bấm đúp `setup.cmd` thay cho `npm run setup`. Trên macOS/Linux script không tự cài MongoDB: cài MongoDB Community (chuỗi mặc định `mongodb://127.0.0.1:27017/greencanteen` dùng được ngay) hoặc tạo cluster Atlas rồi đặt `MONGODB_URI` trong `server/.env`. Sau đó tạo admin đầu tiên ([mục 7.3](#73-quản-trị-viên)) và chạy như [mục 5](#5-chạy-môi-trường-phát-triển).

Mỗi máy có DB, mật khẩu và khóa riêng do `setup` sinh ra; dữ liệu và tài khoản không đi theo GitHub. Khóa Google/Facebook phải điền lại vào `server/.env` của máy đó, không gửi tệp `.env` qua tin nhắn hay email. Máy chưa có SMTP hoặc chưa tải mô hình nhận diện thì xem [mục 4](#4-chạy-thử-nhanh-không-cần-mongodb) để in email ra log và dùng check-in mô phỏng khi chạy thử.

## 4. Chạy thử nhanh (không cần MongoDB)

Chỉ để xem thử khi phát triển. **Dữ liệu mất khi tắt server.** Trong `server/.env` đặt:

```
MONGODB_MEMORY_FALLBACK=true   # không kết nối được MongoDB thì dùng DB in-memory
VISION_SIMULATION=true         # check-in trả kết quả MÔ PHỎNG cố định, có gắn nhãn, không phải nhận diện thật
EMAIL_TRANSPORT=console        # email xác minh / đặt lại mật khẩu được in ra log của server thay vì gửi đi
```

Với `EMAIL_TRANSPORT=console`, khi đăng ký bằng email hãy **mở log của server để lấy liên kết xác minh**.

Mở hai cửa sổ dòng lệnh, chạy [mục 5](#5-chạy-môi-trường-phát-triển), rồi vào http://localhost:5173.

Các chế độ mô phỏng này bị tắt tự động khi `NODE_ENV=production`.

## 5. Chạy môi trường phát triển

MongoDB cài bằng `npm run setup` không tự chạy sau khi khởi động lại máy: bật trước bằng `start-mongodb.cmd` trong thư mục cài MongoDB. Sau đó chạy **hai tiến trình** ở hai cửa sổ dòng lệnh:

| Cửa sổ | Lệnh (từ thư mục gốc) | Địa chỉ |
|---|---|---|
| API | `npm run dev:server` | http://localhost:3001 (kiểm tra: `/api/health`) |
| Giao diện | `npm run dev:client` | http://localhost:5173 (proxy `/api` → 3001) |

- Server tự khởi động lại khi tệp trong `server/src/` thực sự đổi nội dung.
- Mỗi lần khởi động, server dọn tệp tạm, chạy migration, đồng bộ câu chuyện (`server/src/data/stories.json`), rồi in ra phương thức nào đang tắt / đang mô phỏng. Chưa có phiên bản móc khóa nào đang hiệu lực thì log báo quay thưởng tri ân đang tạm dừng: server không tự tạo cấu hình vì ảnh, số lượng và nơi nhận quà phải do quản trị viên nhập.
- Chỉ chạy **một** server API trên cổng 3001 cho mỗi thư mục dự án.
- Muốn thử trên điện thoại cùng mạng LAN (ví dụ thử mã QR): `npm run dev --prefix client -- --host`.

Lệnh khác của server (chạy trong `server/`):

| Lệnh | Việc làm |
|---|---|
| `npm start` | Chạy server không tự khởi động lại (dùng cho production) |
| `npm run seed` | Đồng bộ câu chuyện từ `stories.json` bằng tay (server cũng tự làm khi khởi động) |
| `npm run admin:bootstrap -- --email <email> --name "<tên>"` | Tạo quản trị viên đầu tiên (xem [mục 7.3](#73-quản-trị-viên)) |
| `npm run admin:reset-mfa -- --email <email>` | Đặt lại MFA của một quản trị viên |
| `npm run admin:reset-password -- --email <email> [--new-email <email mới>]` | Đặt mật khẩu mới cho quản trị viên (hỏi ẩn, nhập hai lần), đổi email nếu cần. Dùng được khi chưa có SMTP |
| `npm run admin:delete-user -- --student-id <mã SV>` | Xóa hẳn một tài khoản theo yêu cầu của chủ tài khoản, xem [mục 7.3](#73-quản-trị-viên). Có thể dùng `--email <email>` thay cho mã SV |
| `npm run claim-code -- <mã SV> [số giờ]` | Cấp mã kích hoạt cho tài khoản cũ (tạo từ luồng cũ) |
| `npm run vision:download` / `vision:verify` / `vision:evaluate` | Tải, kiểm tra, đánh giá bộ nhận diện ảnh bằng ảnh thật |
| `npm run vision:benchmark` | Đo tốc độ / RAM bộ nhận diện trên máy đang chạy (xem [mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)) |

## 6. Cấu hình `server/.env`

Mẫu đầy đủ có chú thích từng biến: [`server/.env.example`](server/.env.example). **Không đưa `.env` vào mã nguồn** (đã nằm trong `.gitignore`).

Các biến cần quan tâm nhất:

| Biến | Ý nghĩa |
|---|---|
| `NODE_ENV` | `development` hoặc `production`. Production chặn mọi chế độ mô phỏng, email console và DB in-memory |
| `PORT` | Cổng API, mặc định `3001` |
| `HOST` | Địa chỉ lắng nghe, mặc định `127.0.0.1` (chỉ Nginx / Vite trên cùng máy gọi được API). Container, Docker, Render: `0.0.0.0`; production ghi cảnh báo để nhắc chỉ mở cổng API qua proxy |
| `MONGODB_URI` | Chuỗi kết nối MongoDB, mặc định `mongodb://127.0.0.1:27017/greencanteen` |
| `CLIENT_ORIGIN` | Địa chỉ giao diện (dùng cho CORS và điều hướng sau đăng nhập). Production: tên miền HTTPS cuối cùng, vì passkey gắn với tên miền này |
| `TRUST_PROXY` | Địa chỉ reverse proxy đứng trước server (vd. `loopback`). **Không** dùng `true` hay `*` |
| `COOKIE_SECURE`, `COOKIE_SAMESITE` | Cookie phiên. Tự bật `secure` khi production; client và API khác site thì `COOKIE_SAMESITE=none` + HTTPS |
| `EMAIL_TRANSPORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Gửi email. Thiếu SMTP thì **không đăng ký bằng email** và không dùng được "Quên mật khẩu". Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `BREVO_API_KEY`, `RESEND_API_KEY` | Gửi email qua API HTTPS thay cho SMTP (`EMAIL_TRANSPORT=brevo` hoặc `resend`), cho nơi chặn cổng SMTP như Railway. Các bước: [Email (cả hai cách)](#email-cả-hai-cách) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Đăng nhập Google (bỏ trống ID/secret thì nút báo "Chưa cấu hình"). Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_CALLBACK_URL` | Đăng nhập Facebook. Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `VISION_ENGINE` | `classifier` (mặc định và duy nhất: bộ phân loại ONNX trong tiến trình, chỉ dùng CPU) hoặc `off`. Giá trị cũ `ensemble`, `clip`, `ollama` đã bị gỡ: check-in bằng ảnh tắt và log khởi động báo cần đổi thành `classifier` |
| `VISION_CLASSIFIER_MODEL`, `VISION_CLASSIFIER_THREADS` | Mô hình và số luồng CPU cho engine `classifier` (xem [mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)) |
| `VISION_CONFIDENCE_THRESHOLD`, `VISION_TIMEOUT_MS` | Ngưỡng tin cậy (mặc định 0.8, giá trị cũ hiệu chỉnh cho CLIP, chưa hiệu chỉnh lại cho bộ phân loại) và thời gian chờ (mặc định 20000 ms) |
| `VISION_SELF_CHECK` | Bước tự kiểm khi nạp mô hình có `selfCheck` trong manifest (hiện chỉ mô hình học trên ảnh thật): chấm lại 4 ảnh chuẩn, lệch quá dung sai thì không nạp và check-in báo chưa sẵn sàng. `warn` chỉ ghi lỗi, dành cho máy đã chấm lại bằng ảnh có nhãn |
| `VISION_MODEL_URL` | Chỉ dùng khi chạy `npm run vision:download` cho mô hình huấn luyện tại chỗ: địa chỉ HTTPS của tệp mô hình, tệp tải về vẫn phải đúng sha256 trong manifest. Không cần lưu trong `.env` |
| `CHECKIN_COOLDOWN_MINUTES` | Khoảng cách tối thiểu giữa hai check-in được thưởng, mặc định 30 phút. `0` = tắt, chỉ khi phát triển (production ghi cảnh báo) |
| `CHECKIN_DAILY_MAX` | Số check-in được thưởng tối đa của một tài khoản trong một ngày (giờ Việt Nam), mặc định 3. Lượt bị từ chối không tính. `0` = tắt (production ghi cảnh báo) |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Máy chạy `clamd` để quét mã độc ảnh. Bỏ trống thì không quét |
| `ADMIN_MFA_KEY` | Khóa 32 byte cho khu quản trị, 2FA và mã 6 số trong thư "Quên mật khẩu". Thiếu thì mọi `/api/admin` trả 503 và thư "Quên mật khẩu" chỉ có liên kết |
| `AUTH_*`, `CAPTCHA_*`, `API_RATE_LIMIT_PER_MINUTE` | Giới hạn chống dò mật khẩu / đăng ký hàng loạt. Cả trường có thể dùng chung một IP NAT nên ngưỡng phải rộng; cách chọn: [mục 8.9](#89-chọn-ngưỡng-giới-hạn-theo-sĩ-số) |
| `ANALYTICS_ENABLED`, `ANALYTICS_HASH_KEY` | Thống kê truy cập ẩn danh cho khu quản trị |
| `ANALYTICS_EVENTS_PER_VISIT`, `ANALYTICS_VISITS_PER_IP` | Trần chống thổi phồng số liệu: số sự kiện của một lượt truy cập trong 30 phút (mặc định 120), số lượt truy cập mới từ một IP trong 10 phút (mặc định 600). Sự kiện không cần đăng nhập nên số liệu truy cập chỉ mang tính tham khảo |

Tạo `ADMIN_MFA_KEY` (và một khóa **khác** cho `ANALYTICS_HASH_KEY`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Biến cho **client** (đặt lúc build, tiền tố `VITE_`):

| Biến | Ý nghĩa |
|---|---|
| `VITE_API_URL` | Địa chỉ API khi API và giao diện khác nguồn. Để trống nếu cùng tên miền (qua reverse proxy) |
| `VITE_SITE_URL` | Địa chỉ công khai của trang, bật `sitemap.xml` và thẻ canonical |

### 6.1. Nối đăng nhập email, Gmail, Facebook

Mã nguồn đã xử lý đủ các luồng này, chỉ thiếu khóa của từng nhà cung cấp. Khóa nào chưa có thì nút tương ứng báo "Chưa cấu hình", các phương thức khác vẫn chạy.

Điền khóa trực tiếp vào `server/.env` rồi **khởi động lại API**, vì server dev không tự nạp lại tệp này. Khóa chỉ nằm trong tệp đó, không dán vào chat, tài liệu hay mã nguồn.

| Phương thức | Cần có | Khi chạy trên máy | Khi mở cho mọi người |
|---|---|---|---|
| Email + mật khẩu | SMTP | `EMAIL_TRANSPORT=console`: liên kết xác minh, mã và liên kết đặt lại mật khẩu nằm trong log của API, không có thư thật | SMTP thật |
| Google | Client ID, Client secret | Dùng được ngay | Publish app, khai callback HTTPS |
| Facebook | App ID, App secret | Chỉ người có vai trò trong app | Tên miền HTTPS, khai báo `/privacy.html` và `/data-deletion.html`, Advanced Access, chế độ Live |

**Email qua Gmail**

1. Bật [Xác minh 2 bước](https://myaccount.google.com/signinoptions/twosv) cho tài khoản Gmail dùng để gửi thư.
2. Tạo [Mật khẩu ứng dụng](https://myaccount.google.com/apppasswords), đặt tên `GreenCanteen`, sao chép mã 16 ký tự.
3. Trong `server/.env`:

   ```
   EMAIL_TRANSPORT=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=<địa chỉ Gmail>
   SMTP_PASS=<mã 16 ký tự, bỏ dấu cách>
   EMAIL_FROM="GreenCanteen <địa chỉ Gmail>"
   ```

4. Khởi động lại API. Log phải có dòng `SMTP sẵn sàng: smtp.gmail.com`.

Gmail cá nhân có thể báo vượt giới hạn khi gửi quá khoảng 500 thư một ngày, và mật khẩu ứng dụng bị thu hồi khi đổi mật khẩu Google. Cả khối đăng ký cùng lúc, hoặc chạy trên Render Free (chặn cổng 587), thì dùng SMTP của trường hoặc [Brevo](#email-cả-hai-cách).

**Google / Gmail**

1. Mở [Google Auth Platform](https://console.cloud.google.com/auth/overview), tạo project, bấm **Get started**: tên ứng dụng `GreenCanteen`, email hỗ trợ, Audience chọn **External**, email liên hệ.
2. Vào **Clients → Create client**, Application type chọn **Web application**. Trong **Authorized redirect URIs** thêm đúng địa chỉ sau, không thêm dấu `/` ở cuối:

   ```
   http://localhost:5173/api/auth/google/callback
   ```

3. Sao chép Client ID và Client secret vào `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, rồi khởi động lại API.
4. Vào **Audience → Publish app** để ai có tài khoản Google cũng đăng nhập được. Ứng dụng chỉ xin `openid`, `email`, `profile` là các scope cơ bản.

**Facebook**

1. Mở [Meta for Developers](https://developers.facebook.com/apps), **Create app**, chọn trường hợp sử dụng đăng nhập bằng Facebook.
2. Trong phần tùy chỉnh trường hợp sử dụng, thêm quyền `email`. Quyền `public_profile` có sẵn.
3. Vào **App settings → Basic**, sao chép App ID và App secret vào `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, rồi khởi động lại API.
4. App mới ở **Development mode**: chỉ người có vai trò trong app đăng nhập được, thêm người thử ở **App roles**. Chế độ này tự cho phép `http://localhost` nên chưa cần khai callback.

Mở cho mọi người phải có tên miền HTTPS, rồi:

1. Khai `https://<tên miền>/api/auth/facebook/callback` trong **Valid OAuth Redirect URIs**. Facebook so khớp tuyệt đối.
2. Trong khu quản trị, mục thiết lập website, điền **Thông tin liên hệ hỗ trợ** có địa chỉ email. Hai trang dưới đây hiện liên hệ từ ô này, chưa điền thì chỉ có câu chung chung, không đạt yêu cầu của Meta về kênh yêu cầu xóa còn hiệu lực.
3. Trong **App settings → Basic**, điền Privacy Policy URL là `https://<tên miền>/privacy.html`, mục xóa dữ liệu người dùng chọn URL hướng dẫn và điền `https://<tên miền>/data-deletion.html`. Thử hai URL bằng [Sharing Debugger](https://developers.facebook.com/tools/debug/), phải trả HTTP 200.
4. Chuyển `public_profile`, `email` lên Advanced Access. Tài liệu Meta ghi app Consumer được tự duyệt hai quyền này, nhưng chỗ khác lại ghi Advanced Access cần Xác minh doanh nghiệp, nên xem trên bảng điều khiển của app.
5. Chuyển app sang chế độ **Live**.

Hai trang nằm ở `client/privacy.html`, `client/data-deletion.html`, thuộc nhóm trang thông tin, chính sách tĩnh ở [mục 8.12](#812-trang-thông-tin-chính-sách): đọc được mà không chạy JavaScript, nội dung bám theo những gì mã nguồn đang làm nhưng **chưa qua tư vấn pháp lý**. Thay đổi cách thu thập hay lưu dữ liệu thì sửa các tệp này và ngày cập nhật, rồi build lại.

**Khi có tên miền thật**

Đổi `CLIENT_ORIGIN` sang tên miền HTTPS. Liên kết trong email và callback Google/Facebook lấy theo biến này, trừ khi đặt riêng `GOOGLE_CALLBACK_URL`, `FACEBOOK_CALLBACK_URL`. Khai thêm callback mới trên Google và Facebook, giữ callback localhost nếu vẫn phát triển trên máy.

**Kết quả đúng khi thử**

| Thử | Kết quả đúng |
|---|---|
| Đăng ký bằng email | Nhận thư, mở liên kết, nhập lại mật khẩu đã đặt thì tài khoản mới được tạo |
| Google/Facebook lần đầu | Quay về trang **Cá nhân**, popup "Hoàn tất đăng ký" hỏi họ tên và mã sinh viên |
| Google/Facebook lần sau | Vào thẳng tài khoản. Tài khoản đã bật 2FA vẫn phải nhập mã |
| Email Google/Facebook trùng một tài khoản đã có | Báo lỗi, không tự gộp. Đăng nhập bằng cách cũ, rồi bấm **Liên kết** ở trang **Cá nhân** |
| Tài khoản tạo từ Facebook | Không có email, vì Graph API không cho biết email đã xác minh hay chưa. Người dùng này không dùng được "Quên mật khẩu" |

### 6.2. Bộ phân loại ONNX (engine `classifier`)

Nhận diện ảnh bằng một mô hình phân loại nhỏ chạy **trực tiếp trong tiến trình server** bằng `onnxruntime-node`, chỉ dùng CPU, không cần GPU hay dịch vụ ngoài. Đây là bộ nhận diện duy nhất của server: CLIP và Ollama đã bị gỡ. Đo ngày 2026-11-07 trên Ryzen 7 7735H bằng `npm run vision:benchmark`: p50 8 ms, p95 11 ms mỗi ảnh khi mô hình đã nạp, RSS đỉnh 161 MB kể cả mô hình; tệp mô hình 8 MB.

```bash
cd server
npm run vision:download onnxmodelzoo/mobilenetv3_small_075_Opset17   # tải mô hình có kiểm mã băm
npm run vision:benchmark   # đo tốc độ / RAM trên máy đang chạy
```

Trong `server/.env`: `VISION_ENGINE=classifier` là mặc định (mô hình ghim `onnxmodelzoo/mobilenetv3_small_075_Opset17`, đổi bằng `VISION_CLASSIFIER_MODEL`; số luồng CPU qua `VISION_CLASSIFIER_THREADS`, nên để 1–2 trên container nhỏ). Tệp `.env` cũ còn `VISION_ENGINE=ensemble`, `clip` hoặc `ollama` thì check-in bằng ảnh tắt cho tới khi đổi thành `classifier`; các biến `VISION_OLLAMA_*`, `VISION_CLIP_MODEL`, `VISION_ALLOW_CLIP_ONLY` không còn tác dụng, xóa được.

**Bắt buộc đọc trước khi mở thưởng thật:** artifact hiện tại là mô hình ImageNet-pretrained ghép với **bảng ánh xạ lớp** (ghi trong `server/src/data/classifier-models.json`) — **chưa hề huấn luyện trên ảnh thật của trường**. Trên tập đồ họa tổng hợp để test nó an toàn tuyệt đối (0% thưởng nhầm) nhưng gần như từ chối tất cả. Muốn dùng cho thưởng thật:

1. Thu thập 50–100 ảnh có nhãn (bình cá nhân, ly nhựa dùng một lần, vật khác, không có vật) từ chính trường.
2. Chạy `npm run vision:evaluate -- <thư mục ảnh> --engine classifier` — xem tỉ lệ thưởng nhầm / từ chối nhầm và quét ngưỡng để chọn `VISION_CONFIDENCE_THRESHOLD`.
3. Chỉ khi tỉ lệ thưởng nhầm chấp nhận được mới mở thưởng thật. Trong lúc chưa đánh giá, phương án dự phòng trong mã là `VISION_ENGINE=off` (tắt check-in bằng ảnh); CLIP + Ollama chỉ còn khôi phục được từ lịch sử git.

Mô hình lớn hơn trong manifest (`mobilenetv3_large_100`, `efficientnet_lite0`) đổi được bằng `VISION_CLASSIFIER_MODEL` nếu sau này đánh giá thấy tốt hơn.

**Mô hình học trên ảnh chụp thật (tùy chọn, 2026-11-08):** `greencanteen/bev9-dinov2-vitb-280-int8` gồm backbone DINOv2 ViT-B tách từ checkpoint RF-DETR 2XLarge (`D:\training\weights.pt`, do tài khoản Roboflow của dự án huấn luyện trên bộ *Beverage Containers* của Roboflow Universe Projects, giấy phép CC BY 4.0) và một lớp tuyến tính 9 lớp. Cách huấn luyện và toàn bộ số đo: `D:\training\session-20261107-1602\05-continuation\README.md`. Tệp `model.int8.onnx` (87 MB) không có trên Hugging Face: chép vào `server/models/greencanteen/bev9-dinov2-vitb-280-int8/`, hoặc đặt `VISION_MODEL_URL` là địa chỉ HTTPS của tệp khi chạy `npm run vision:download` (tệp tải về vẫn phải đúng sha256 trong manifest). Không có cả hai thì lệnh chỉ báo cách chép, không gọi mạng.

```bash
cd server
npm run vision:verify greencanteen/bev9-dinov2-vitb-280-int8
```

Bật trong `server/.env` (mã nguồn và `.env.example` vẫn dùng mobilenet):

```
VISION_CLASSIFIER_MODEL=greencanteen/bev9-dinov2-vitb-280-int8
VISION_CONFIDENCE_THRESHOLD=0.95
```

0.95 là ngưỡng đã hiệu chỉnh trên tập valid; đặt thấp hơn thì log khởi động cảnh báo. Khi nạp mô hình này, server chấm lại 4 ảnh chuẩn đi kèm repo (`src/data/vision-selfcheck`) và so với giá trị đo trên máy hiệu chỉnh: máy khác (Linux, CPU khác loại) mà lệch quá 0.05 thì không nạp, check-in báo chưa sẵn sàng thay vì thưởng theo số đo không còn đúng. `npm run vision:selfcheck` chạy bước này bằng tay. Triển khai trên Railway: [Cách 3](#cách-3-railway-có-check-in-bằng-ảnh). Lần nhìn thứ hai (F-26) của mô hình này chỉ đòi ảnh đã làm mờ chữ vẫn là bình/ly cá nhân với độ tin cậy từ 0.5 (`secondLook.minConfidence` trong manifest); đòi 0.95 như lần đầu thì trên ảnh test chỉ còn nhận đúng 127/287 (44,3%). Đo qua đúng pipeline check-in (ngưỡng 0.95), trên các tập chưa dùng khi chọn cấu hình:

| Tập | Thưởng nhầm | Nhận đúng bình/ly cá nhân |
|---|---|---|
| Ảnh test của bộ dữ liệu (ảnh chụp, 9 loại vật chứa) | 0/318 (0,0%), CI95 0,0–1,1% | 224/287 (78,0%), CI95 72,8–82,7% |
| Chai PET, lon, chai thủy tinh, chai sữa (drinking-waste, CC0) | 2/800 (0,2%), CI95 0,0–0,9% | — |
| Ảnh vẽ đối kháng holdout (chữ đánh lừa) | 1/53 (1,9%) | 18/25 (72,0%) |

Hạn chế đã biết: chưa đo trên ảnh chụp ở căn tin của trường; mô hình không có lớp "không có vật chứa" nên ảnh lạ vẫn bị gán một trong 9 lớp; chai thủy tinh đôi khi bị nhận là bình/ly cá nhân; ly rượu được tính là không thưởng (chờ chủ dự án quyết định); điều khoản dùng trọng số RF-DETR 2XLarge chưa xác minh. Mô hình nặng hơn mobilenet nhiều (số đo ở [mục 8.2](#82-nhận-diện-ảnh-bộ-phân-loại-onnx-trên-cpu)). Khi trường đã có đủ dữ liệu thật, huấn luyện lại (fine-tune) và thay tệp `.onnx` + cập nhật manifest — mã nguồn engine không cần đổi.

## 7. Hướng dẫn sử dụng

### 7.1. Sinh viên

Mở trang chủ (trên điện thoại có thể "Thêm vào màn hình chính" để dùng như ứng dụng).

1. **Đăng nhập / đăng ký**: vào trang **Cá nhân**, một popup hiện ra. Chọn email + mật khẩu, Google, Facebook, mã QR hoặc passkey.
   Đăng ký bằng email cần mở liên kết xác minh gửi qua email, rồi đặt mật khẩu.
2. **Check-in**: vào trang **Check-in**, chụp ảnh (hoặc tải ảnh lên) bình/ly nước cá nhân của bạn. Server nhận diện ảnh:
   - Là bình/ly cá nhân với độ tin cậy đủ cao: **+10 điểm** và **1 lượt quay thưởng tri ân**, kèm popup câu chuyện khoa học có nguồn.
   - Ly nhựa dùng một lần, vật chứa khác, ảnh không rõ hoặc không có vật chứa: không được thưởng.
3. **Quay thưởng tri ân**: mỗi lượt có cơ hội trúng một móc khóa GreenCanteen; phần lớn lượt không trúng. Trúng thì nhận mã nhận quà (trong popup và ở trang **Cá nhân**), mang tới nơi trao quà theo hướng dẫn trên trang `/gacha-rules.html`.
4. **Bảng xếp hạng**: xem top theo tuần hoặc tháng; ảnh đại diện đổi được ở trang **Cá nhân**.
5. **Bảo mật tài khoản** (trang **Cá nhân**): đổi mật khẩu, bật xác thực hai lớp, thêm passkey, liên kết Google/Facebook, đăng xuất các thiết bị khác.

Đăng nhập bằng mã QR: trên máy muốn đăng nhập chọn "Mã QR", dùng thiết bị đã đăng nhập quét mã, nhập mã đối chiếu 4 chữ số và xác nhận.

### 7.2. Tài khoản cũ

Tài khoản tạo bằng "mã SV + họ tên" ở phiên bản cũ không còn đăng nhập được chỉ bằng mã SV. Quản trị viên xác minh danh tính (thẻ SV) rồi cấp mã kích hoạt:

```bash
cd server
npm run claim-code -- <mã sinh viên> 72
```

Sinh viên đăng ký mới bằng đúng mã SV cũ, nhập **Mã kích hoạt** thì dữ liệu cũ (điểm, lịch sử, phần thưởng) được gắn vào tài khoản mới.

### 7.3. Quản trị viên

Không có API nào tạo quản trị viên đầu tiên. Làm một lần trên máy chủ, với `MONGODB_URI` là MongoDB thật:

1. Tạo `ADMIN_MFA_KEY` (xem [mục 6](#6-cấu-hình-serverenv)) và đặt vào `server/.env`.
2. Chạy lệnh sau, **thay `admin@truong.edu.vn` bằng email bạn sẽ dùng để đăng nhập**. Lệnh hỏi mật khẩu (≥ 12 ký tự) hai lần bằng dấu nhắc ẩn, nên hãy tắt bộ gõ tiếng Việt trước khi gõ, rồi in **mã đăng ký MFA đúng một lần**:

   ```bash
   cd server
   npm run admin:bootstrap -- --email admin@truong.edu.vn --name "Họ Tên Quản Trị"
   ```

3. Mở `https://<tên-miền>/admin`, đăng nhập, nhập mã đăng ký, quét QR bằng ứng dụng xác thực (TOTP), nhập mã 6 số và **lưu 8 mã khôi phục**.

Trong khu quản trị: tổng quan số liệu, tài khoản (khóa/mở, đổi quyền, đặt lại MFA), câu chuyện (nháp → xuất bản), quay thưởng tri ân (phiên bản cấu hình, ảnh & sticker, trao quà), thiết lập website, nhật ký kiểm toán.

**Quay thưởng tri ân** (khu quản trị → Quay thưởng tri ân):

1. **Ảnh & sticker**: tải ảnh móc khóa, sticker khi trúng, sticker khi không trúng (PNG, JPEG, WebP hoặc GIF động, tối đa 8 MB). Máy chủ quét mã độc (nếu bật ClamAV), nén lại thành WebP giữ chuyển động, bỏ metadata. Sticker đang bật được chọn ngẫu nhiên cho màn hình kết quả; chưa có sticker thì giao diện dùng biểu tượng mặc định. Ảnh móc khóa đang được bản nháp hoặc phiên bản còn hiệu lực dùng thì không xóa được.
2. **Phiên bản cấu hình** → **Tạo bản nháp mới**: mỗi dòng là một mẫu móc khóa gồm ảnh, tên, mô tả, xác suất trúng mỗi lượt (%, tối đa 4 chữ số thập phân, nhỏ nhất 0,0001% = 1 trên 1.000.000) và **tổng số lượng** móc khóa thật. Tổng xác suất tối đa 100%, phần còn lại là không trúng. Số đã trúng đếm chung theo mã dòng qua mọi phiên bản, nên sao phiên bản mới từ bản cũ không cấp lại số móc khóa đã trao; nhận thêm móc khóa thì tăng tổng số lượng. Nhập **hướng dẫn nhận quà** (nơi, giờ, cần mang gì, hạn nhận) rồi **Xuất bản** (cần xác thực lại).
3. **Trao quà**: người trúng đưa mã nhận quà `TA-XXXXX-XXXXX`; tra đúng nguyên mã, đối chiếu tài khoản (tên, mã sinh viên đã che; mở trang tài khoản nếu cần xem đầy đủ) rồi bấm **Đã trao**. Bấm nhầm thì **Hoàn tác** kèm lý do. Mọi thao tác ghi nhật ký kiểm toán.

Cách rút: máy chủ rút một số trong 1.000.000 bằng `crypto.randomInt`; số rơi vào khoảng của mẫu nào thì trúng mẫu đó. Mẫu đã hết thì phần xác suất của nó tính là không trúng; mọi mẫu đều hết thì không cho quay và giữ lượt. Lượt không trúng cũng được ghi lại. Khi cập nhật từ bản mã nạp demo, migration `2026-11-gacha-keychain` ngừng hiệu lực các phiên bản mã nạp (không xóa dữ liệu); mã nạp demo đã phát vẫn hiện ở trang Cá nhân, mục "Mã nạp demo cũ".
Phiên quản trị ngắn (mặc định 15 phút nhàn rỗi, tối đa 8 giờ); thao tác nhạy cảm yêu cầu xác thực lại.

**Thêm admin khác:** Khu quản trị → Tài khoản → chọn tài khoản → **Cấp quyền quản trị**. Tài khoản phải có email và mật khẩu. Sau khi xác thực lại, màn hình hiện mã đăng ký MFA một lần, trao cho người đó qua kênh an toàn.

**Yêu cầu xóa dữ liệu:** Sinh viên gửi yêu cầu theo trang `/data-deletion.html`. Đối chiếu thẻ sinh viên để chắc đúng chủ tài khoản, rồi chạy trên máy chủ:

```bash
cd server
npm run admin:delete-user -- --student-id <mã sinh viên>
```

Lệnh in tài khoản sắp xóa và số dữ liệu, rồi bắt gõ lại mã sinh viên. Lệnh xóa tài khoản, ảnh đại diện, check-in, kết quả quay thưởng (kể cả móc khóa chưa nhận, mã nạp demo cũ), phiên đăng nhập, passkey, 2FA và **không hoàn tác được**. Tài khoản quản trị phải gỡ quyền trước. Nhật ký kiểm toán được giữ lại, bản sao lưu cũ vẫn còn dữ liệu cho tới khi bị ghi đè. Thời hạn theo khoản 4 Điều 5 Nghị định 356/2025/NĐ-CP, đã công bố ở `/data-deletion.html`: phản hồi người yêu cầu trong 02 ngày làm việc, xóa xong trong 20 ngày kể từ khi nhận yêu cầu đúng thủ tục, gia hạn tối đa một lần không quá 20 ngày và phải báo lý do. Xong việc hãy báo lại cho người yêu cầu.

| Sự cố | Cách xử lý |
|---|---|
| Mất điện thoại, còn mã khôi phục | Đăng nhập bằng mã khôi phục, nhờ admin khác **Đặt lại MFA** để gắn thiết bị mới |
| Mất điện thoại, hết mã khôi phục | Admin khác: Tài khoản → **Đặt lại MFA**. Không còn admin nào khác: `npm run admin:reset-mfa -- --email <email>` |
| Quên mật khẩu admin, hoặc gõ nhầm email lúc khởi tạo | Trên máy chủ: `npm run admin:reset-password -- --email <email hiện tại> [--new-email <email mới>]`. Có SMTP thì dùng được "Quên mật khẩu" ở trang công khai. Phiên quản trị bị thu hồi, MFA đã gắn giữ nguyên |
| Sinh viên mất thiết bị 2FA, hết mã khôi phục | Đối chiếu thẻ sinh viên, rồi Tài khoản → chọn tài khoản → **Tắt xác thực hai lớp** |
| Nghi lộ `ADMIN_MFA_KEY` | Thay khóa, chạy `admin:reset-mfa` cho từng admin, tắt 2FA cho từng sinh viên đã bật, kiểm tra nhật ký kiểm toán |

**Xem thử khi chưa có MongoDB:** công cụ kiểm thử có sẵn API với DB in-memory, khóa sinh ngẫu nhiên và nhận diện ảnh mô phỏng. Dữ liệu mất khi tắt, không dùng cho môi trường thật. Tắt `dev:server` và `dev:client` trước để Vite chiếm đúng cổng 5173, rồi chạy ba lệnh trong ba cửa sổ (cú pháp Git Bash):

```bash
cd server && E2E_CLIENT_ORIGIN=http://localhost:5173 npm run e2e:server
```

```bash
cd client && API_PROXY_TARGET=http://127.0.0.1:3101 npm run dev
```

```bash
curl.exe -X POST http://127.0.0.1:3102/admin-fixture
```

Lệnh cuối trả về email, mật khẩu thử và mã đăng ký MFA của một tài khoản admin mới. Mở http://localhost:5173/admin để đăng nhập.

## 8. Triển khai (production)

API **không** phục vụ giao diện. Cần: MongoDB, tiến trình Node chạy API, và một máy chủ web (Nginx...) phục vụ `client/dist` và chuyển `/api/` tới API.

Không có ngân sách máy chủ, chỉ cần demo: xem [mục 8.11](#811-triển-khai-miễn-phí-để-demo).

### 8.1. Chuẩn bị máy chủ

```bash
# Linux: lấy mã nguồn về (vd. /opt/greencanteen), cài thư viện chỉ cho production
cd /opt/greencanteen/server
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev   # không tải thư viện CUDA: nhận diện ảnh chỉ dùng CPU
npm run vision:download && npm run vision:verify
```

Tạo `server/.env` cho production (tối thiểu):

```
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb://<user>:<pass>@<host>:27017/greencanteen
CLIENT_ORIGIN=https://greencanteen.truong.edu.vn
TRUST_PROXY=loopback

VISION_ENGINE=classifier
VISION_CLASSIFIER_THREADS=2
CHECKIN_COOLDOWN_MINUTES=30

EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp.truong.edu.vn
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="GreenCanteen <no-reply@truong.edu.vn>"

ADMIN_MFA_KEY=<khóa base64 32 byte>
```

Production **dừng khởi động** nếu không kết nối được MongoDB (không tự dùng DB tạm).

### 8.2. Nhận diện ảnh (bộ phân loại ONNX trên CPU)

Check-in bằng ảnh chạy bằng bộ phân loại ONNX ngay trong tiến trình API ([mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)), không cần GPU, Ollama hay máy nhận diện riêng:

```bash
cd /opt/greencanteen/server
npm run vision:download && npm run vision:verify
npm run vision:benchmark   # đo tốc độ / RAM trên chính máy chủ này
```

- Ảnh được chấm lần lượt từng ảnh; quá `VISION_MAX_QUEUE` ảnh đang chờ thì API trả 503 "máy chủ đang bận" thay vì để CPU quá tải. Ảnh bị hết giờ (`VISION_TIMEOUT_MS`) vẫn giữ chỗ trong hàng tới khi suy luận thật sự xong, vì không dừng được giữa chừng: lúc CPU quá tải, ảnh mới bị báo bận sớm thay vì chạy chồng lên các lượt cũ. Lượt treo hẳn chỉ giữ hàng tối đa gấp 3 lần `VISION_TIMEOUT_MS`, sau đó log có dòng `[vision] Bộ phân loại chưa xong` và hàng chạy tiếp.
- `VISION_CLASSIFIER_THREADS` (1–8) giới hạn số luồng CPU của onnxruntime; container nhỏ nên để 1–2.
- Ảnh sắp được thưởng được chấm lại trên bản đã làm mờ chữ (F-26), nên một check-in được thưởng tốn hai lượt suy luận.
- Trước khi mở cho sinh viên, đánh giá bằng ảnh thật rồi chọn ngưỡng: `npm run vision:evaluate -- <thư mục ảnh>` (trong `server/`). Ngưỡng mặc định 0.8 là giá trị cũ hiệu chỉnh cho CLIP.

Số đo ngày 2026-11-07 trên Ryzen 7 7735H (Windows 11, Node 24, `npm run vision:benchmark`): nạp mô hình 155 ms, p50 8 ms và p95 11 ms mỗi ảnh, 4 ảnh đồng thời 33 ms, ảnh 6000×6000 65 ms, RSS đỉnh 161 MB. Máy cloud tính theo vCPU, nên đo lại trên đúng máy đó trước khi chọn gói.

Mô hình tùy chọn `greencanteen/bev9-dinov2-vitb-280-int8` ([mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)), đo ngày 2026-11-08 trên cùng máy, 2 luồng (`npm run vision:benchmark -- --model greencanteen/bev9-dinov2-vitb-280-int8`): nạp mô hình 587 ms, p50 184 ms và p95 351 ms mỗi lượt suy luận, 4 ảnh đồng thời 1,4 s (chấm lần lượt), ảnh 6000×6000 475 ms, RSS đỉnh 259 MB. Ảnh được thưởng tốn hai lượt nên mất khoảng 0,4–0,7 s. Ảnh được chấm lần lượt nên khi nhiều sinh viên gửi cùng lúc, ảnh cuối phải đợi các ảnh trước (tối đa `VISION_MAX_QUEUE` ảnh); thời gian đợi trong hàng không tính vào `VISION_TIMEOUT_MS`. Chưa đo trên máy cloud nào.

### 8.3. Build giao diện

```bash
cd client
npm ci
VITE_SITE_URL=https://greencanteen.truong.edu.vn npm run build
# thêm VITE_API_URL=https://api.truong.edu.vn nếu API ở tên miền khác
```

```powershell
# Windows PowerShell
$env:VITE_SITE_URL = "https://greencanteen.truong.edu.vn"; npm run build
```

Kết quả nằm ở `client/dist/`, gồm `index.html` (sinh viên), `admin/index.html` (quản trị) và các trang thông tin, chính sách tĩnh ([mục 8.12](#812-trang-thông-tin-chính-sách)). Chép thư mục này tới máy chủ web.

### 8.4. Chạy API như một dịch vụ (systemd)

`/etc/systemd/system/greencanteen.service`:

```ini
[Unit]
Description=GreenCanteen API
After=network.target mongod.service

[Service]
Type=simple
User=greencanteen
WorkingDirectory=/opt/greencanteen/server
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
# Dừng êm: server trả xong request đang xử lý (tối đa ~7 giây) khi nhận SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now greencanteen
journalctl -u greencanteen -f        # xem log khởi động
curl http://127.0.0.1:3001/api/health
```

Log khởi động cho biết phương thức nào đang tắt, và **không được có dòng `Cấu hình chưa an toàn`**.
Có thể dùng trình quản lý tiến trình khác (pm2, Docker...) miễn là chạy `node src/index.js` trong thư mục `server/` và gửi SIGTERM khi dừng.

### 8.5. Nginx và HTTPS

Dùng Let's Encrypt (`certbot --nginx`) cho HTTPS và chuyển cổng 80 sang 443. API chỉ có van xả theo IP trong bộ nhớ (`API_RATE_LIMIT_PER_MINUTE`), nên lớp chặn tải đầu tiên phải nằm ở proxy.

```nginx
# Đặt trong khối http. Ngưỡng theo IP phải rộng vì cả trường có thể đi Internet qua một IP NAT; kiểm tra lại theo sĩ số thực tế.
limit_req_zone $binary_remote_addr zone=gc_api:10m rate=30r/s;
limit_conn_zone $binary_remote_addr zone=gc_conn:10m;

server {
  listen 443 ssl http2;
  server_name greencanteen.truong.edu.vn;
  root /var/www/greencanteen;          # nội dung client/dist

  # Cắt kết nối gửi chậm (slowloris) sớm hơn API, nơi đặt 20 giây cho header và 120 giây cho cả yêu cầu
  client_header_timeout 10s;
  client_body_timeout 30s;

  location /api/ {
    # Mặc định Nginx chỉ nhận 1 MB; ảnh check-in và ảnh đại diện tối đa 8 MB
    client_max_body_size 10m;
    limit_req zone=gc_api burst=120 nodelay;
    limit_conn gc_conn 200;
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Mọi đường dẫn con của /admin phải trả trang quản trị
  location ^~ /admin {
    # CSP trong thẻ meta không đặt được frame-ancestors, phải đặt ở đây
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    add_header Cache-Control "no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    try_files /admin/index.html =404;
  }

  location / {
    # frame-ancestors chống nhúng trang duyệt QR vào iframe
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options "DENY" always;
    try_files $uri /index.html;
  }
}
```

Cấu hình sai `/admin` thì đường dẫn đó rơi về ứng dụng sinh viên (không lộ gì), nhưng trang quản trị sẽ không mở được.

### 8.6. Khởi tạo quản trị viên và kiểm tra sau triển khai

1. Chạy `npm run admin:bootstrap` như [mục 7.3](#73-quản-trị-viên).
2. Mở `https://<tên-miền>/api/health` → `{"ok":true,...}`.
3. Đăng ký thử một tài khoản (kiểm SMTP), check-in thử một ảnh thật (kiểm bộ phân loại ONNX), đăng nhập `/admin`.
4. Đăng nhập sai một lần từ máy ngoài, kiểm tra `db.ratelimits.find({ key: /^login-fail-ip:/ })` có đúng IP thật (kiểm `TRUST_PROXY`).

### 8.7. Danh sách kiểm tra production

- [ ] HTTPS, `NODE_ENV=production`, `CLIENT_ORIGIN` đúng tên miền cuối cùng (đổi sau này thì mọi passkey mất tác dụng).
- [ ] `TRUST_PROXY` là địa chỉ proxy thật, không phải `true`/`*`; ngưỡng `AUTH_*_IP_MAX` và `API_RATE_LIMIT_PER_MINUTE` hợp với sĩ số trường.
- [ ] SMTP đã cấu hình; tên miền gửi thư có SPF, DKIM, DMARC.
- [ ] Đã đặt **Thông tin liên hệ hỗ trợ**, đã thay mọi khối "Chưa công bố" (`data-pending`) trong các trang chính sách bằng dữ kiện đã xác minh và đọc lại các trang đó theo đúng cách vận hành thực tế ([mục 8.12](#812-trang-thông-tin-chính-sách)).
- [ ] `VISION_ENGINE=classifier`, mô hình đã tải và khớp mã băm (`npm run vision:verify`), đã đánh giá bằng ảnh thật của trường (mục 6.2) và ghi lại ngưỡng đã chọn.
- [ ] `ADMIN_MFA_KEY` nằm trong kho secret và có bản sao an toàn **tách khỏi** bản sao lưu DB (mất khóa thì mọi MFA mất tác dụng).
- [ ] ClamAV đã cài, `CLAMAV_HOST` trỏ tới `clamd` trong mạng nội bộ, đã thử bằng tệp EICAR ([mục 8.10](#810-quét-mã-độc-bằng-clamav)).
- [ ] MongoDB có tài khoản, có TLS khi ở máy khác, không mở cổng 27017 ra Internet. Tài khoản ứng dụng không có quyền `dropCollection` và không sửa, xóa được `auditlogs`.
- [ ] Sao lưu `mongodump` theo lịch, có bản ngoài máy chủ, đã thử khôi phục. Ứng dụng không tự sao lưu.
- [ ] Cảnh báo khi log có dòng `[audit-write-failed]`. Chốt thời gian lưu nhật ký kiểm toán theo quy định của trường, vì nhật ký không tự xóa.
- [ ] Giới hạn `/admin` và `/api/admin` theo VPN hoặc IP của trường nếu hạ tầng cho phép. Đây là lớp bổ sung, không thay thế xác thực.
- [ ] Có CDN hoặc dịch vụ chống DDoS nếu cần chịu tấn công từ nhiều IP: giới hạn trong ứng dụng và Nginx chỉ có tác dụng với từng nguồn.
- [ ] Không chặn `/admin` trong `robots.txt`: trình thu thập phải đọc được thẻ `noindex`. Bản build cố ý không chặn.

### 8.8. Cập nhật phiên bản

```bash
mongodump --uri "$MONGODB_URI" --out /backup/greencanteen-$(date +%F)   # sao lưu trước
cd /opt/greencanteen && <lấy mã nguồn mới>
cd server && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
cd ../client && npm ci && npm run build        # rồi chép client/dist lên máy chủ web
sudo systemctl restart greencanteen
```

Khi khởi động, server tự chạy migration, đồng bộ câu chuyện (không đè nội dung admin đã sửa) và tạo index. **Không hạ phiên bản** sau khi admin đã sửa câu chuyện; cần hạ thì khôi phục từ bản sao lưu.

### 8.9. Chọn ngưỡng giới hạn theo sĩ số

Một IP có thể đại diện cho hàng nghìn học sinh khi cả trường đi Internet qua một IP NAT, nên ngưỡng phải tính cho cả mạng:

- `AUTH_LOGIN_IP_MAX`: chỉ lần đăng nhập SAI bị đếm. Ước lượng số lần gõ sai cao nhất trong một cửa sổ 15 phút rồi lấy gấp đôi. Ví dụ 1 000 học sinh đăng nhập trong giờ cao điểm, 5% gõ sai hai lần là 100 lần, đặt 200. Ngưỡng càng cao thì kẻ dò rải càng được thử nhiều hơn, nên giữ cùng bậc với thực tế.
- `AUTH_REGISTER_IP_MAX`: mỗi yêu cầu tốn một thư và một lần băm scrypt. Đặt lớn hơn số học sinh đăng ký trong một giờ cao điểm. Tăng tạm thời khi cả khối đăng ký cùng lúc, rồi trả lại sau đợt đó.
- Khi một IP chạm ngưỡng đăng nhập, mọi người trong mạng đó tạm không đăng nhập được bằng mật khẩu tới hết cửa sổ; phiên đang mở, Google, Facebook và mã QR vẫn dùng được. Xóa thủ công một bộ đếm: `db.ratelimits.deleteOne({ key: "login-fail-ip:<ip>" })`.
- `TRUST_PROXY`: sai giá trị thì giới hạn theo IP mất tác dụng hoặc cả trường bị tính là một IP của proxy. Không có proxy thì để trống. Có proxy thì khai báo địa chỉ proxy (`loopback`, `10.0.0.5`, `172.18.0.0/16`). Số proxy (`1`) chỉ an toàn khi cổng API không mở trực tiếp ra ngoài. `true`, `*`, `0.0.0.0/0` bị bỏ qua và ghi lỗi trong log.

### 8.10. Quét mã độc bằng ClamAV

Server gửi từng ảnh check-in và ảnh đại diện tới `clamd` trước khi giải mã, nên đó phải là máy của trường. `clamd` không có xác thực: chỉ cho lắng nghe trên loopback hoặc mạng riêng có tường lửa.

```bash
sudo apt install clamav-daemon clamav-freshclam
```

Trong `/etc/clamav/clamd.conf`, đặt `TCPSocket 3310`, `TCPAddr 127.0.0.1` và `StreamMaxLength` lớn hơn `CHECKIN_MAX_IMAGE_MB`, rồi khởi động lại `clamav-daemon`. `freshclam` cần ra Internet để tải chữ ký. Đặt `CLAMAV_HOST=127.0.0.1` cho server; log khởi động in `clamd sẵn sàng` hoặc lỗi kết nối.

Sau khi cài, thử một lần trên máy chủ bằng tệp EICAR (vô hại, xem eicar.org): `clamdscan` phải báo `FOUND`, và tải tệp đó lên phải bị từ chối với 422 `malware_detected`. Đã đặt `CLAMAV_HOST` mà `clamd` lỗi thì ảnh bị từ chối với 503 `scan_unavailable`, check-in và đổi ảnh đại diện tạm dừng. Bộ test dùng `clamd` giả nên chưa từng chạy với `clamd` thật. ClamAV chỉ nhận ra mẫu có trong cơ sở dữ liệu chữ ký, nên qua lớp này không có nghĩa tệp an toàn.

### 8.11. Triển khai miễn phí để demo

Check-in chỉ cần bộ phân loại ONNX chạy trên CPU (tệp 8 MB; RSS đỉnh 161 MB khi chạy benchmark trên Ryzen 7 7735H, [mục 8.2](#82-nhận-diện-ảnh-bộ-phân-loại-onnx-trên-cpu)). Trên Windows, API production dùng ~109 MB RAM khi tắt nhận diện. Chưa đo trên gói miễn phí nào: Render Free chỉ có 512 MB và 0,1 CPU, nên Cách 2 dưới đây vẫn tắt nhận diện (`VISION_ENGINE=off`) cho tới khi đo được trên đúng gói đó.

| | Cách 1: Local + Cloudflare Tunnel | Cách 2: Render + MongoDB Atlas |
|---|---|---|
| Check-in bằng ảnh | **Có** (bộ phân loại ONNX trên CPU) | **Không** (`VISION_ENGINE=off`), API trả 503. Điểm, lượt quay thưởng từ check-in cũng không phát sinh |
| Địa chỉ | `*.trycloudflare.com`, đổi mỗi lần mở tunnel | `*.onrender.com`, cố định |
| Truy cập được khi | Máy bật và đủ các tiến trình đang chạy | Mọi lúc; ngủ sau 15 phút không có truy cập, lần đầu chờ ~1 phút |
| Nên dùng khi | Buổi demo cần chạy đủ luồng | Cần link cố định để xem giao diện, đăng nhập, bảng xếp hạng, khu quản trị |

[Cách 3](#cách-3-railway-có-check-in-bằng-ảnh) (Railway) chạy được check-in bằng ảnh với mô hình học trên ảnh thật nhưng tốn phí theo mức dùng sau phần tín dụng dùng thử.

Cả hai cách miễn phí đều **chỉ để demo**, không đạt [danh sách production](#87-danh-sách-kiểm-tra-production): không có ClamAV nên log luôn có dòng `Cấu hình chưa an toàn: CLAMAV_HOST`, ảnh tải lên không được quét mã độc. Điều khoản gói miễn phí hay đổi.

**Không làm** mấy việc sau để "chữa cháy" check-in trên cloud:

- Đặt `NODE_ENV=development` để bật `VISION_SIMULATION`: cookie mất `Secure`, và ảnh nào cũng được chấm là hợp lệ.

#### Email (cả hai cách)

Không có SMTP thì **không ai đăng ký được bằng email**, kể cả khi mọi thứ khác chạy. [Brevo](https://www.brevo.com) miễn phí 300 thư/ngày: tạo tài khoản, xác minh địa chỉ gửi, lấy SMTP key tại trang SMTP & API (key này khác API key).

```
EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=2525                    # Render Free chặn 25, 465, 587. Cách 1 dùng 587 cũng được
SMTP_SECURE=false
SMTP_USER=<tên đăng nhập SMTP của Brevo>
SMTP_PASS=<SMTP key>
EMAIL_FROM="GreenCanteen <địa chỉ đã xác minh>"
```

Thư gửi từ địa chỉ chưa xác thực tên miền dễ vào mục Spam, nên nhắc người dùng kiểm tra mục đó.

**Gửi qua API HTTPS (bắt buộc trên Railway).** Railway chỉ mở SMTP từ gói Pro; gói Free, Trial, Hobby phải gửi thư qua API HTTPS ([tài liệu Railway](https://docs.railway.com/reference/outbound-networking)). Server gửi được qua API của Brevo hoặc Resend, các luồng đăng ký, quên mật khẩu, thư báo giữ nguyên:

```
# Brevo: dùng API key (Brevo → SMTP & API → API Keys), khác SMTP key ở trên
EMAIL_TRANSPORT=brevo
BREVO_API_KEY=<API key>
EMAIL_FROM="GreenCanteen <địa chỉ đã xác minh trong Brevo>"
```

```
# Resend: địa chỉ gửi thuộc tên miền đã thêm và xác minh trong Resend
EMAIL_TRANSPORT=resend
RESEND_API_KEY=<API key>
EMAIL_FROM="GreenCanteen <no-reply@tên-miền-của-bạn>"
```

Lúc khởi động, log ghi `Gửi email qua API HTTPS của Brevo, người gửi ...`; server không gọi API khi khởi động nên khóa sai chỉ lộ ra ở thư đầu tiên. Thử bằng "Quên mật khẩu": thư không tới thì log có dòng `Gửi email đặt lại mật khẩu thất bại: EMAIL_API_<mã HTTP>_<mã lỗi của nhà cung cấp>` (đuôi `_unauthorized` là khóa API sai). Log chỉ ghi mã lỗi, không ghi địa chỉ người nhận.

#### Cách 1: Local + Cloudflare Tunnel

Cần `npm run setup` đã chạy xong và đã có mô hình nhận diện ảnh. MongoDB vẫn chỉ nghe `127.0.0.1`, Internet chỉ tới được Caddy qua tunnel.

1. Cài công cụ (một lần):

   ```powershell
   winget install --id CaddyServer.Caddy --exact
   winget install --id Cloudflare.cloudflared --exact
   ```

2. Tạo tệp `Caddyfile` ở thư mục gốc dự án:

   ```caddyfile
   {
   	admin off
   	servers {
   		trusted_proxies static 127.0.0.1/32 ::1/128
   	}
   }

   (trang) {
   	header Strict-Transport-Security "max-age=31536000"
   	header Content-Security-Policy "frame-ancestors 'none'"
   	header X-Frame-Options "DENY"
   }

   :8080 {
   	bind 127.0.0.1
   	root * client/dist
   	encode gzip

   	handle /api/* {
   		request_body {
   			max_size 10MB
   		}
   		reverse_proxy 127.0.0.1:3001
   	}

   	@admin path /admin /admin/*
   	handle @admin {
   		import trang
   		header X-Robots-Tag "noindex, nofollow, noarchive"
   		header Cache-Control "no-store"
   		header Referrer-Policy "no-referrer"
   		rewrite * /admin/index.html
   		file_server
   	}

   	handle {
   		import trang
   		try_files {path} /index.html
   		file_server
   	}
   }
   ```

3. Bật MongoDB bằng `start-mongodb.cmd`, tắt `dev:server` để trống cổng 3001. Rồi build giao diện (làm lại mỗi khi đổi mã client):

   ```bash
   npm run build --prefix client
   ```

4. Mở ba cửa sổ PowerShell từ thư mục gốc dự án. Cửa sổ 1 chạy Caddy:

   ```powershell
   caddy run
   ```

   Cửa sổ 2 mở tunnel, ghi lại địa chỉ `https://....trycloudflare.com` nó in ra:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8080
   ```

   Cửa sổ 3 chạy API. Biến đặt trong cửa sổ này thắng `server/.env` và mất khi đóng cửa sổ, nên cấu hình phát triển không đổi. `MONGODB_URI`, `ADMIN_MFA_KEY`, SMTP vẫn đọc từ `server/.env`:

   ```powershell
   cd server
   $env:NODE_ENV = "production"
   $env:CLIENT_ORIGIN = "https://<địa chỉ tunnel>"
   $env:TRUST_PROXY = "loopback"
   $env:VISION_ENGINE = "classifier"
   $env:CHECKIN_COOLDOWN_MINUTES = "30"
   npm start
   ```

5. Tạo admin nếu chưa có ([mục 7.3](#73-quản-trị-viên)), mở `https://<địa chỉ tunnel>/api/health` rồi thử check-in một ảnh thật.

Lưu ý:

- Mỗi lần mở lại tunnel địa chỉ đổi: chạy lại API với `CLIENT_ORIGIN` mới. Passkey và callback Google/Facebook gắn với địa chỉ cũ sẽ mất tác dụng, nên buổi demo dùng email + mật khẩu hoặc mã QR. Muốn địa chỉ cố định phải có tên miền riêng trên Cloudflare và tạo tunnel có tên.
- Quick Tunnel chỉ dành cho thử nghiệm: tối đa 200 yêu cầu đồng thời, không cam kết hoạt động liên tục.
- Xong việc thì tắt tunnel (`Ctrl+C`) để đóng đường vào máy của bạn.

#### Cách 2: Render + MongoDB Atlas

Tên `greencanteen` và `greencanteen-api` dưới đây chỉ là ví dụ. Tên đã có người dùng thì Render tự thêm hậu tố vào địa chỉ, nên sau khi tạo dịch vụ hãy xem địa chỉ thật trên Dashboard và sửa `CLIENT_ORIGIN`, `VITE_SITE_URL`, rewrite `/api/*` cho khớp. Đổi `VITE_SITE_URL` thì phải build lại.

1. **Đưa mã lên GitHub** theo [mục 3](#đưa-lên-github-và-chạy-trên-máy-khác), dùng repository riêng tư (Private).

2. **Tạo MongoDB Atlas.** Tạo Free cluster ở vùng gần Render (vd. Singapore). Trong Database Access, tạo tài khoản chỉ có quyền `readWrite` trên DB `greencanteen`. Trong Network Access, thêm IP máy của bạn và dải IP ra của Render (trang dịch vụ, nút Connect, tab Outbound). Không lấy được thì mới dùng `0.0.0.0/0`, khi đó chỉ còn mật khẩu DB bảo vệ. Chuỗi kết nối có dạng dưới đây, ký tự đặc biệt trong mật khẩu phải mã hóa URL:

   ```
   mongodb+srv://<user>:<pass>@<host>/greencanteen?retryWrites=true&w=majority
   ```

3. **Tạo khóa mới**, không dùng lại khóa của máy phát triển. Chạy lệnh ở [mục 6](#6-cấu-hình-serverenv) hai lần, một cho `ADMIN_MFA_KEY`, một cho `ANALYTICS_HASH_KEY`.

4. **Tạo API** trên Render: New > Web Service, chọn repository, đặt tên `greencanteen-api`, vùng Singapore, gói Free.

   | Mục | Giá trị |
   |---|---|
   | Root Directory | `server` |
   | Build Command | `ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev` |
   | Start Command | `node src/index.js` |
   | Health Check Path | `/api/health` |

   Biến môi trường, cộng thêm phần SMTP ở trên:

   ```
   NODE_VERSION=24
   NODE_ENV=production
   HOST=0.0.0.0
   MONGODB_URI=<chuỗi Atlas>
   CLIENT_ORIGIN=https://greencanteen.onrender.com
   TRUST_PROXY=1
   VISION_ENGINE=off
   ADMIN_MFA_KEY=<khóa mới>
   ANALYTICS_HASH_KEY=<khóa mới khác>
   ```

   Log sẽ có cảnh báo về `TRUST_PROXY=1` và `HOST=0.0.0.0`: chấp nhận được vì cổng API trên Render không mở trực tiếp ra ngoài, chỉ đi qua proxy của Render. Thiếu `HOST=0.0.0.0` thì API chỉ nghe trên loopback và Render báo dịch vụ không phản hồi.

5. **Tạo giao diện**: New > Static Site, cùng repository, đặt tên `greencanteen`, để địa chỉ trùng `CLIENT_ORIGIN`.

   | Mục | Giá trị |
   |---|---|
   | Root Directory | `client` |
   | Build Command | `npm ci --include=dev && npm run build` |
   | Publish Directory | `dist` |
   | Biến môi trường | `NODE_VERSION=24`, `VITE_SITE_URL=https://greencanteen.onrender.com` |

   **Không đặt `VITE_API_URL`.** Giao diện phải gọi API cùng nguồn qua rewrite dưới đây: gọi thẳng sang `greencanteen-api.onrender.com` là khác site, cookie phiên bị trình duyệt chặn (Safari chặn cookie bên thứ ba).

   Mục Redirects/Rewrites, thêm đúng thứ tự, Action đều là **Rewrite**:

   | Source | Destination |
   |---|---|
   | `/api/*` | `https://greencanteen-api.onrender.com/api/*` |
   | `/admin` | `/admin/index.html` |
   | `/admin/*` | `/admin/index.html` |
   | `/*` | `/index.html` |

   Mục Headers:

   | Path | Name | Value |
   |---|---|---|
   | `/*` | `Strict-Transport-Security` | `max-age=31536000` |
   | `/*` | `Content-Security-Policy` | `frame-ancestors 'none'` |
   | `/*` | `X-Frame-Options` | `DENY` |
   | `/admin/*` | `X-Robots-Tag` | `noindex, nofollow, noarchive` |
   | `/admin/*` | `Cache-Control` | `no-store` |
   | `/admin/*` | `Referrer-Policy` | `no-referrer` |

   `/admin/*` không khớp chính `/admin`, nên thêm ba dòng tương tự với Path `/admin`.

6. **Tạo quản trị viên từ máy của bạn**, vì Render Free không có shell. Trong PowerShell (biến trong phiên thắng `server/.env`, nên lệnh ghi vào Atlas chứ không vào DB local), rồi đóng cửa sổ sau khi xong:

   ```powershell
   cd server
   $env:MONGODB_URI = "<chuỗi Atlas>"
   $env:ADMIN_MFA_KEY = "<đúng khóa đã đặt trên Render>"
   npm run admin:bootstrap -- --email admin@truong.edu.vn --name "Họ Tên Quản Trị"
   ```

7. **Kiểm tra.** Mở `https://greencanteen.onrender.com/api/health` phải thấy `{"ok":true,...}`, đăng ký thử một tài khoản, đăng nhập `/admin`. Trang Check-in báo chưa sẵn sàng là đúng với cách này. Đăng nhập sai một lần rồi xem collection `ratelimits` trên Atlas: khóa `login-fail-ip:` phải là IP thật của bạn. Nếu là IP của Render thì cả trang dùng chung một bộ đếm, khi đó tăng `AUTH_LOGIN_IP_MAX` theo [mục 8.9](#89-chọn-ngưỡng-giới-hạn-theo-sĩ-số).

Giới hạn cần biết:

| Giới hạn | Ảnh hưởng |
|---|---|
| API ngủ sau 15 phút, 750 giờ chạy mỗi tháng | Mở `/api/health` vài phút trước buổi demo. Dùng dịch vụ ping miễn phí mỗi 10 phút thì không ngủ, tốn ~744 giờ/tháng nên chỉ đủ cho một dịch vụ |
| 0,1 CPU | Đăng nhập, băm mật khẩu và khởi động chậm hơn nhiều so với máy phát triển (chưa đo trên Render thật) |
| 5 GB băng thông mỗi tháng, tính chung cả hai dịch vụ | Không gắn thẻ thì hết băng thông dịch vụ bị dừng tới đầu tháng sau, không phát sinh phí |
| Atlas: 0,5 GB, 100 thao tác/giây, 500 kết nối | Ảnh đại diện lưu trong MongoDB nên cũng tính vào 0,5 GB. Đĩa Render mất khi khởi động lại nhưng ứng dụng không giữ gì lâu dài trên đó |
| Atlas tự tạm dừng sau 30 ngày không có kết nối | Vào Atlas bấm Resume. Bật sao lưu Free cluster nếu dữ liệu đáng giữ (lưu tối đa 4 bản hằng ngày) |

#### Cách 3: Railway (có check-in bằng ảnh)

Railway tính tiền theo RAM và CPU dùng thực tế. Hướng dẫn này **chưa được chạy thử trên Railway thật**: số đo ở [mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier) và [8.2](#82-nhận-diện-ảnh-bộ-phân-loại-onnx-trên-cpu) là của máy Windows dùng để hiệu chỉnh. Gói Free (0,5 GB RAM, 1 vCPU) quá sát cho mô hình học trên ảnh thật: API kèm mô hình ước khoảng 350–400 MB (chưa đo trên Linux), và một tài khoản gửi dồn ảnh PNG cực lớn còn làm RAM tăng thêm vài trăm MB. Thử bằng gói Trial (1 GB, 2 vCPU dùng chung), chạy thật bằng Hobby. Chưa có ClamAV nên cũng chưa đạt [danh sách production](#87-danh-sách-kiểm-tra-production).

Giao diện làm như bước 5 của Cách 2 (Static Site của Render, hoặc nơi khác có rewrite `/api/*`), chỉ đổi đích rewrite thành địa chỉ API trên Railway. Rewrite giữ trình duyệt ở cùng một địa chỉ nên cookie phiên vẫn dùng được. Đừng cho giao diện gọi thẳng địa chỉ Railway (`VITE_API_URL`): khi đó cookie phiên thành cookie bên thứ ba và Safari (mọi trình duyệt trên iPhone, iPad) chặn hẳn, kể cả với `COOKIE_SAMESITE=none`.

Trước khi gửi, giao diện thu nhỏ ảnh chọn từ thư viện hoặc chụp bằng camera về cạnh dài tối đa 2048 px và nén JPEG chất lượng 0,85 (`client/src/lib/imageCompress.js`), nên request đi qua proxy rewrite nhẹ hơn nhiều so với ảnh gốc; ảnh nhỏ hơn 2048 px và nhẹ hơn 1,5 MB được gửi nguyên. Ảnh trình duyệt không đọc được thì gửi nguyên tệp (tối đa `CHECKIN_MAX_IMAGE_MB`). Proxy của Vercel không công bố giới hạn kích thước request khi rewrite ra ngoài, nên sau khi triển khai hãy thử check-in một ảnh lớn.

1. **MongoDB và khóa:** như bước 2–3 của Cách 2; Network Access của Atlas phải cho phép kết nối từ Railway.

2. **Tạo service API** từ repository GitHub. Settings:

   | Mục | Giá trị |
   |---|---|
   | Root Directory | `server` |
   | Start Command | để trống: Railpack chạy script `start` (`node src/index.js`) |
   | Healthcheck Path | `/api/health` |

   Không dùng `railway.json`: Railway đã ngừng nhận config-as-code cho service mới.

3. **Thêm volume** cho service, mount tại `/data` (Free/Trial 0,5 GB, Hobby 5 GB; mô hình mới 87 MB, mobilenet 8 MB). Volume chỉ gắn khi container khởi động, nên tệp ghi ra lúc build không nằm trên volume.

4. **Biến môi trường**, cộng thêm phần gửi qua API HTTPS (Brevo hoặc Resend) ở [Email (cả hai cách)](#email-cả-hai-cách). Không dùng SMTP: Railway chặn SMTP trừ gói Pro.

   ```
   RAILPACK_NODE_VERSION=24
   RAILPACK_NODE_NPM_INSTALL=npm ci
   ONNXRUNTIME_NODE_INSTALL=skip
   NODE_ENV=production
   HOST=0.0.0.0
   MONGODB_URI=<chuỗi kết nối>
   CLIENT_ORIGIN=https://<địa chỉ giao diện>
   TRUST_PROXY=1
   ADMIN_MFA_KEY=<khóa mới>
   ANALYTICS_HASH_KEY=<khóa mới khác>
   VISION_ENGINE=classifier
   VISION_MODEL_DIR=/data/models
   VISION_CLASSIFIER_MODEL=greencanteen/bev9-dinov2-vitb-280-int8
   VISION_CONFIDENCE_THRESHOLD=0.95
   VISION_TIMEOUT_MS=60000
   VISION_CLASSIFIER_THREADS=2
   ```

   - `HOST=0.0.0.0` là bắt buộc: Railway chỉ chuyển request vào ứng dụng nghe `0.0.0.0` trên cổng `PORT` (Railway tự đặt `PORT`). Thiếu biến này thì API chỉ nghe loopback và Railway báo "Application Failed to Respond".
   - `RAILPACK_NODE_VERSION=24` là bản Node đã đo; `engines` của server chỉ ghi `>=20`.
   - Railpack mặc định chạy `npm install`. `RAILPACK_NODE_NPM_INSTALL=npm ci` cài đúng phiên bản trong `package-lock.json` (onnxruntime-node 1.30.0, sharp 0.35.5) và báo lỗi nếu lockfile lệch `package.json`.
   - `ONNXRUNTIME_NODE_INSTALL=skip`: trên Linux x64, bước cài của onnxruntime-node mặc định tải thêm thư viện CUDA, server chỉ chạy CPU.
   - `VISION_CLASSIFIER_THREADS` đặt bằng số vCPU của gói.
   - `VISION_ENGINE`, `VISION_CLASSIFIER_MODEL`, `VISION_CONFIDENCE_THRESHOLD`, `VISION_TIMEOUT_MS` giống `server/.env` của máy hiệu chỉnh. Thiếu `VISION_CLASSIFIER_MODEL` thì server dùng mặc định của mã (mobilenet, gần như từ chối mọi ảnh thật) và log khởi động có dòng lỗi `... chưa được hiệu chỉnh trên ảnh có nhãn`. Thiếu `VISION_TIMEOUT_MS` thì thời gian chờ là 20000 ms.
   - `VISION_TIMEOUT_MS=60000`: sinh viên chờ tối đa 60 giây cho một lượt chấm; lượt treo giữ hàng tối đa 180 giây ([mục 8.2](#82-nhận-diện-ảnh-bộ-phân-loại-onnx-trên-cpu)). Proxy rewrite của giao diện cũng phải chờ đủ lâu: Vercel chờ máy chủ ngoài tối đa 120 giây ([changelog](https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes)); Render chưa công bố con số, một chủ đề cũ trên [diễn đàn Render](https://community.render.com/t/15-second-request-timeout/568) ghi 30 giây. Giao diện đặt trên Render thì lượt chấm quá thời gian đó báo lỗi proxy thay vì thông báo hết giờ của server.
   - Log production sẽ cảnh báo về `HOST` và `TRUST_PROXY`; chấp nhận được vì service chỉ nhận request qua proxy của Railway.

5. **Đưa mô hình vào volume** (một lần). Tệp `model.int8.onnx` không nằm trong git và Railway không lấy tệp Git LFS.

   Trên máy đang có mô hình, kiểm tệp trước khi đưa lên: `npm run vision:verify greencanteen/bev9-dinov2-vitb-280-int8` (trong `server/`) phải báo khớp; tệp đúng nặng 87 429 450 byte, sha256 `3d271658d446eb97d858f1e4c2569b7b42a2136eb08282215bf910c412df9856`. Đặt tệp ở một địa chỉ HTTPS tạm chỉ bạn biết. Địa chỉ phải trả thẳng nội dung tệp: liên kết mở trang xem trước (như liên kết chia sẻ thường của Google Drive) không qua được bước kiểm sha256 và không có tệp nào được ghi.

   Cài Railway CLI trên máy của bạn (`npm i -g @railway/cli`, rồi `railway login` và `railway link` trong thư mục dự án), mở shell trong container bằng `railway ssh` (lần đầu cần đăng ký SSH key với Railway) và chạy:

   ```bash
   VISION_MODEL_URL="https://<địa chỉ tạm>/model.int8.onnx" npm run vision:download greencanteen/bev9-dinov2-vitb-280-int8
   npm run vision:download onnxmodelzoo/mobilenetv3_small_075_Opset17
   npm run vision:selfcheck
   ```

   `vision:download` chỉ ghi tệp khi đúng kích thước và sha256 trong manifest, nên địa chỉ bị tráo nội dung cũng không đưa được mô hình khác vào. Đặt `VISION_MODEL_URL` ngay trên dòng lệnh, không lưu thành biến của service. Xong thì xóa tệp ở địa chỉ tạm (điều khoản phân phối trọng số chưa xác minh) và Redeploy để server nạp mô hình.

6. **Tạo quản trị viên** ngay trong `railway ssh`: `npm run admin:bootstrap -- --email admin@truong.edu.vn --name "Họ Tên Quản Trị"` (lệnh dùng `MONGODB_URI` và `ADMIN_MFA_KEY` của service).

7. **Kiểm tra.**
   - Log khởi động phải có `Nhận diện ảnh tại máy chủ: bộ phân loại ONNX (greencanteen/bev9-dinov2-vitb-280-int8, ...), ngưỡng 0.95` và không có dòng lỗi `... chưa được hiệu chỉnh trên ảnh có nhãn`.
   - Log khởi động phải có `Bộ phân loại ONNX đã sẵn sàng (... ms); tự kiểm 4 ảnh chuẩn: lệch lớn nhất ... (cho phép 0.05).` Chỉ dòng log này (hoặc `npm run vision:selfcheck`) cho biết mô hình đã nạp được: `/api/checkin/status` chỉ phản ánh cấu hình (`"mode":"local"`), kể cả khi mô hình thiếu tệp hay không qua bước tự kiểm.
   - Thấy dòng `[vision-self-check]` báo không qua bước tự kiểm nghĩa là máy Railway tính khác máy hiệu chỉnh: check-in tự tắt, không thưởng nhầm. Chấm lại trên Railway bằng ảnh có nhãn của trường (`npm run vision:evaluate`, [mục 6.2](#62-bộ-phân-loại-onnx-engine-classifier)); chỉ khi chấp nhận kết quả mới đặt `VISION_SELF_CHECK=warn`. Ghi lại loại CPU bằng `grep -m1 'model name' /proc/cpuinfo`.
   - Qua bước tự kiểm chỉ có nghĩa 4 ảnh chuẩn lệch không quá 0,05; tỉ lệ thưởng nhầm và nhận đúng trên Railway vẫn chưa được đo.
   - Kiểm `TRUST_PROXY` như bước 7 của Cách 2: khóa `login-fail-ip:` trong collection `ratelimits` phải là IP thật của bạn.

### 8.12. Trang thông tin, chính sách

Tám trang HTML tĩnh ở `client/`, đọc được khi không chạy JavaScript. Danh sách và thứ tự ở chân trang nằm trong `client/src/legal/pages.js`; chân trang chung được chèn vào chỗ `<!--legal-footer-->` khi chạy dev và khi build.

| Đường dẫn | Nội dung |
|---|---|
| `/about.html` | Giới thiệu GreenCanteen |
| `/contact.html` | Liên hệ. Kênh liên hệ lấy từ **Thông tin liên hệ hỗ trợ** trong khu quản trị |
| `/terms.html` | Điều khoản sử dụng |
| `/privacy.html` | Chính sách bảo mật và xử lý dữ liệu cá nhân (URL khai với Meta) |
| `/data-deletion.html` | Hướng dẫn xóa dữ liệu (URL khai với Meta) |
| `/operating-rules.html` | Quy chế hoạt động. Thanh toán, giao nhận, đổi trả, hoàn tiền, kiểm hàng ghi "Chưa áp dụng" vì không có chức năng bán hàng |
| `/gacha-rules.html` | Thể lệ quay thưởng tri ân. Mẫu móc khóa, ảnh, xác suất, số còn lại và hướng dẫn nhận quà lấy từ `GET /api/gacha/rules`: cấu hình đang hiệu lực, không cần đăng nhập, không lộ ghi chú nội bộ. Đường dẫn giữ tên cũ để liên kết đã chia sẻ không hỏng |
| `/complaints.html` | Tiếp nhận và giải quyết khiếu nại, tranh chấp |

Nội dung chỉ ghi điều kiểm được trong mã nguồn và trong văn bản pháp luật tra cứu ngày 07/11/2026: Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15, Nghị định 356/2025/NĐ-CP, Luật Thương mại điện tử 122/2025/QH15, Nghị định 248/2026/NĐ-CP, Luật Bảo vệ quyền lợi người tiêu dùng 19/2023/QH15, Luật Thương mại (văn bản hợp nhất 113/VBHN-VPQH), Nghị định 81/2018/NĐ-CP (văn bản hợp nhất 55/VBHN-BCT, đã gồm Nghị định 239/2026/NĐ-CP), Nghị định 30/2007/NĐ-CP, Nghị định 147/2024/NĐ-CP. Các trang **chưa qua tư vấn pháp lý**.

Dữ kiện chưa xác minh được để trong khối "Chưa công bố" có thuộc tính `data-pending` (tìm bằng `grep -n data-pending client/*.html`):

| `data-pending` | Cần chủ dự án xác nhận |
|---|---|
| `operator`, `controller`, `organizer` | Tên, tư cách pháp lý, địa chỉ, người đại diện của đơn vị vận hành; bên kiểm soát dữ liệu; người phụ trách bảo vệ dữ liệu; đơn vị tổ chức quay thưởng tri ân, nguồn kinh phí và giá trị móc khóa |
| `support-contact` | Kênh liên hệ chính thức. Đặt ở khu quản trị; khối này tự ẩn khi đã đặt |
| `processors`, `cross-border` | Nhà cung cấp máy chủ, cơ sở dữ liệu, email, máy quét mã độc; nơi đặt máy chủ và bản sao lưu; có bật thống kê truy cập không |
| `retention` | Thời hạn lưu nhật ký kiểm toán, giá trị `ANALYTICS_RETENTION_DAYS` đang dùng, lịch sao lưu |
| `children` | Độ tuổi người dùng, cách lấy ý kiến cha mẹ hoặc người giám hộ |
| `complaint-deadlines` | Thời hạn báo đã nhận và giải quyết khiếu nại ngoài yêu cầu về dữ liệu |

Điền xong một mục thì thay cả khối bằng nội dung đã xác minh, sửa ngày "Cập nhật lần cuối", rồi build lại. Đổi cách thu thập, lưu dữ liệu hay cơ chế quay thưởng thì sửa trang tương ứng cùng lúc với mã. Không gắn biểu tượng "Đã thông báo/Đã đăng ký Bộ Công Thương": biểu tượng này chỉ cấp qua online.gov.vn cho nền tảng thương mại điện tử đã thông báo hoặc đăng ký (Điều 45 Nghị định 248/2026/NĐ-CP), GreenCanteen không bán hàng nên không thuộc diện này.

## 9. Kiểm thử

Test không cần tài khoản hay khóa thật: MongoDB in-memory riêng; Google, Facebook, SMTP đều được giả lập. Từ thư mục gốc:

| Lệnh | Việc làm |
|---|---|
| `npm test` | Unit + integration của server, rồi unit + UI của client |
| `npm run test:e2e` | Kiểm thử hệ thống bằng Playwright (Edge/Chrome cài sẵn trong máy). Tự chạy API thử ở cổng 3101 và Vite ở 5174, không đụng server dev |
| `npm run test:e2e:build` | Kiểm bản build thật: CSP, service worker, robots |
| `npm run coverage` | Độ phủ C0/C1/C2 → `server/coverage/`, `client/coverage/` |

Test nhận diện bằng bộ phân loại ONNX thật chỉ chạy khi đã có mô hình trong `server/models/` (`npm run vision:download`), không thì tự bỏ qua và ghi lý do.

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Vite báo `ECONNRESET` / `ECONNREFUSED` | API không chạy, đang khởi động lại, hoặc cổng 3001 bị tiến trình khác chiếm (server báo « Cổng 3001 đang được tiến trình khác dùng »). Chỉ chạy một API trên cổng 3001 |
| Mọi tài khoản biến mất sau khi khởi động lại | Đang dùng DB in-memory (không kết nối được MongoDB). Chạy MongoDB thật và đặt `MONGODB_URI` |
| Server không khởi động, "Không kết nối được MongoDB" | Chưa bật MongoDB: chạy `start-mongodb.cmd` trong thư mục cài MongoDB. Đã đặt `MONGODB_URI` hoặc chạy production thì server không tự dùng DB tạm. Kiểm tra `MONGODB_URI`, mạng, tài khoản |
| Check-in báo "chưa sẵn sàng" (503) | Thiếu mô hình (`npm run vision:download`), hoặc `VISION_ENGINE` không hợp lệ: giá trị cũ `ensemble`, `clip`, `ollama` phải đổi thành `classifier`. Xem log khởi động |
| Check-in báo "máy chủ đang bận" | Quá `VISION_MAX_QUEUE` ảnh chờ nhận diện; tăng tài nguyên hoặc giảm tải |
| Check-in báo "mất quá nhiều thời gian" | CPU máy chủ quá tải hoặc nhiều ảnh đang xếp hàng. Đo bằng `npm run vision:benchmark` trên đúng máy đó, so với số đo ở [mục 8.2](#82-nhận-diện-ảnh-bộ-phân-loại-onnx-trên-cpu); chỉnh `VISION_CLASSIFIER_THREADS`, `VISION_TIMEOUT_MS`, `VISION_MAX_QUEUE` |
| Tab "Tạo tài khoản" hoặc "Quên mật khẩu" báo "Chưa cấu hình" | Chưa có `SMTP_HOST` / `EMAIL_FROM`; với `EMAIL_TRANSPORT=brevo` / `resend` là thiếu `BREVO_API_KEY` / `RESEND_API_KEY` hoặc `EMAIL_FROM` không đúng dạng `Tên <email>`. Khi phát triển dùng `EMAIL_TRANSPORT=console` |
| Thư không tới, log có `thất bại: EMAIL_API_...` | Nhà cung cấp API từ chối. Phần sau mã HTTP là mã lỗi của nhà cung cấp: đuôi `_unauthorized` là khóa API sai; mã khác thì kiểm tra địa chỉ trong `EMAIL_FROM` đã được xác minh với nhà cung cấp chưa. Trên Railway mà log báo không kết nối được SMTP: Railway chặn SMTP, chuyển sang `EMAIL_TRANSPORT=brevo` hoặc `resend` |
| Nút Google / Facebook báo "Chưa cấu hình" | Thiếu ID hoặc secret trong `server/.env`, hoặc đã điền mà chưa khởi động lại API |
| Trang Google báo `redirect_uri_mismatch` | Callback không khớp tuyệt đối với **Authorized redirect URIs**, kể cả `http`/`https`, cổng và dấu `/` ở cuối |
| Trang Facebook báo `URL blocked` | Callback chưa có trong **Valid OAuth Redirect URIs**. `http://localhost` chỉ được tự cho phép ở Development mode |
| Facebook báo app chưa hoạt động, người khác không đăng nhập được | App còn ở Development mode. Thêm người đó ở **App roles**, hoặc làm các bước mở cho mọi người ở [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| Chọn xong tài khoản Google/Facebook nhưng báo "Không thể đăng nhập", log có `OAuth callback failed` | Secret sai, hoặc máy chủ không gọi được tới nhà cung cấp. Lý do nằm ngay sau dòng log đó |
| Báo "Phiên đăng nhập không hợp lệ hoặc đã hết hạn" | Mở bằng `127.0.0.1` trong khi callback dùng `localhost`, hoặc chờ quá 10 phút. Cookie gắn với tên máy nên phải dùng đúng địa chỉ trong `CLIENT_ORIGIN` |
| Log có `Không kết nối được SMTP smtp.gmail.com: Invalid login` | `SMTP_PASS` phải là mật khẩu ứng dụng, không phải mật khẩu Gmail. Tạo lại nếu vừa đổi mật khẩu Google |
| `/api/admin/...` trả 503 | Thiếu hoặc sai định dạng `ADMIN_MFA_KEY` |
| Cả trường bị chặn đăng nhập (429) | Sau proxy mà thiếu `TRUST_PROXY` nên mọi người bị tính chung một IP; hoặc ngưỡng `AUTH_LOGIN_IP_MAX` quá thấp so với sĩ số |
| `/admin` hiện ứng dụng sinh viên | Nginx chưa có khối `location ^~ /admin`; hoặc máy đã cài PWA cũ, đợi service worker tự cập nhật |
| Upload ảnh lỗi 413 | Nginx giới hạn 1 MB mặc định; đặt `client_max_body_size 10m` |
| Quản trị viên mất điện thoại xác thực hoặc quên mật khẩu | Xem bảng sự cố ở [mục 7.3](#73-quản-trị-viên) |

## 11. Giới hạn hiện tại

- Quay thưởng tri ân trao móc khóa thật: trước khi xuất bản phiên bản đầu tiên phải xác định đơn vị tổ chức, nguồn kinh phí, giá trị móc khóa và rà lại pháp lý. Nếu một thương nhân (vd. đơn vị kinh doanh căn tin) tài trợ hoặc dùng hoạt động này để xúc tiến bán hàng thì đó là khuyến mại, mà khoản 7 Điều 100 Luật Thương mại cấm khuyến mại tại trường học; không bao giờ thu phí, bán lượt quay hay cho đổi điểm lấy lượt (khoản 1, 9 Điều 6 Nghị định 30/2007/NĐ-CP đã sửa đổi). Không quảng bá hoạt động này như xổ số.
- Móc khóa không có hạn nhận tự động: mã nhận quà không tự hủy, hạn nhận chỉ là chữ trong hướng dẫn nhận quà. Tài khoản bị xóa khi còn móc khóa chưa nhận thì bộ đếm vẫn tính móc khóa đó là đã trúng; tăng tổng số lượng ở phiên bản sau nếu cần.
- Bộ sinh số ngẫu nhiên và cách rút chưa được bên thứ ba kiểm định; xác suất nhỏ nhất biểu diễn được là 1 trên 1.000.000.
- Chưa có bước ghi nhận đồng ý theo Điều 9 Luật Bảo vệ dữ liệu cá nhân và Điều 6 Nghị định 356/2025/NĐ-CP: đăng ký không có ô đồng ý, không lưu thời điểm và phiên bản chính sách đã đồng ý; thống kê truy cập bật theo mặc định (`ANALYTICS_ENABLED=true` trong `.env.example`) mà không hỏi ý kiến; bảng xếp hạng công khai họ tên, ảnh đại diện mà không có tùy chọn ẩn.
- Không hỏi tuổi, chưa có cách lấy ý kiến cha mẹ hoặc người giám hộ nếu người dùng là trẻ em (Điều 24 Luật Bảo vệ dữ liệu cá nhân).
- Nhật ký kiểm toán không tự xóa, tài khoản lâu không dùng không tự xóa: cần chốt thời hạn lưu (khoản 3 Điều 3 Luật Bảo vệ dữ liệu cá nhân).
- Ứng dụng sinh viên tải phông chữ từ Google Fonts, nên trình duyệt gửi địa chỉ IP cho Google; trang chính sách đã ghi rõ điều này.
