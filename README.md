# GreenCanteen

Nền tảng web (PWA) giúp học sinh/sinh viên **check-in** việc dùng bình/ly nước cá nhân tại căn tin thay cho ly nhựa dùng một lần.
Sinh viên chụp ảnh bình/ly, **máy chủ của trường** tự nhận diện ảnh (không gửi cho dịch vụ AI cloud), hợp lệ thì được cộng Eco-points và một lượt quay Gacha.

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
        ├── MongoDB                      lưu tài khoản, check-in, Gacha, câu chuyện, nhật ký kiểm toán...
        ├── Google / Facebook OAuth      tùy chọn
        ├── SMTP                         xác minh đăng ký, quên mật khẩu (tùy chọn nhưng cần để đăng ký bằng email)
        ├── ClamAV (clamd)               quét mã độc ảnh tải lên (tùy chọn, nên có ở production)
        └── Nhận diện ảnh check-in TẠI MÁY CHỦ
              ├── CLIP (ONNX, chạy trong tiến trình Node, ngoại tuyến)
              └── Ollama VLM trong mạng nội bộ (kết hợp với CLIP ở chế độ ensemble)
```

**Cấu trúc thư mục**

```
greencanteen/
├── client/    Giao diện React + Vite (trang sinh viên và khu quản trị /admin)
├── server/    API Express + Mongoose
│   ├── src/        mã nguồn (routes, services, models, data/stories.json)
│   ├── scripts/    công cụ: dev server, tải/kiểm/đánh giá mô hình nhận diện
│   ├── models/     mô hình CLIP tải về bằng npm run vision:download (không đưa vào git)
│   └── uploads/    thư mục tạm cho ảnh đang xử lý
├── tools/     script cài đặt (setup.mjs), công cụ đo độ phủ C2 dùng cho test
├── setup.cmd  cài đặt tự động trên Windows
└── package.json   lệnh tiện ích chạy từ thư mục gốc
```

**Tính năng chính:** thống kê toàn trường, đăng nhập (email + mật khẩu, Google, Facebook, mã QR, passkey, xác thực hai lớp),
check-in bằng camera/ảnh, Gacha, bảng xếp hạng tuần/tháng, popup câu chuyện khoa học có nguồn, khu quản trị `/admin` (MFA bắt buộc).

## 2. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Node.js | **20 trở lên** (kèm npm), nên dùng bản LTS từ [nodejs.org](https://nodejs.org) |
| Git | Để clone dự án từ GitHub ([git-scm.com](https://git-scm.com)). Không có Git thì dùng nút "Download ZIP" trên GitHub |
| Trình duyệt | Chrome hoặc Edge: mở trang web, chạy test E2E |
| Ứng dụng xác thực | Google Authenticator, Microsoft Authenticator... trên điện thoại, để bật MFA khi vào khu quản trị |
| MongoDB | Bản cài local (trên Windows, `npm run setup` tự cài) hoặc MongoDB Atlas. Khi phát triển có thể dùng DB in-memory (xem [mục 4](#4-chạy-thử-nhanh-không-cần-mongodb)) |
| Nhận diện ảnh | ~150 MB đĩa cho mô hình CLIP, ~350 MB RAM thêm cho tiến trình server |
| Ollama (tùy chọn) | ≥ 0.12.7, mô hình `qwen3-vl:4b-instruct` (~3,3 GB đĩa, ~5,2 GB RAM hoặc VRAM khi chạy), nên có GPU ([mục 8.2](#82-ollama-nhận-diện-ảnh)). **Bắt buộc ở production**, vì `VISION_ENGINE=ensemble` cần cả CLIP lẫn Ollama |
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
| Mô hình CLIP | Tải ~150 MB vào `server/models/`, kiểm mã băm |
| MongoDB (chỉ Windows) | Tải bản 8.0.34 (~808 MB, ghim mã băm), cài vào `D:\MongoDB` (không có ổ D thì vào thư mục người dùng), chỉ nghe `127.0.0.1`, tạo tài khoản, ghi `MONGODB_URI`. Không cần quyền Administrator, không cài dịch vụ Windows |
| Khóa quản trị | Sinh `ADMIN_MFA_KEY` nếu chưa có |
| Ollama | Tải `qwen3-vl:4b-instruct` (~3,3 GB) nếu đã cài và đang chạy Ollama. Script không tự cài Ollama |

Mật khẩu và khóa chỉ ghi vào tệp, không in ra màn hình: chuỗi kết nối ứng dụng và `ADMIN_MFA_KEY` ở `server/.env`, chuỗi kết nối root ở `mongodb-admin.txt` trong thư mục cài MongoDB. Cuối cùng script in danh sách việc bạn còn phải tự làm.

Tùy chọn: `--mongo-dir <thư mục>`, `--mongo-port <cổng>`, `--skip-mongodb` (dùng MongoDB có sẵn hoặc Atlas), `--skip-ollama`. Truyền qua npm: `npm run setup -- --skip-ollama`.

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

Tải mô hình nhận diện ảnh (một lần, ~150 MB, vào `server/models/`, có kiểm mã băm):

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

Mỗi máy có DB, mật khẩu và khóa riêng do `setup` sinh ra; dữ liệu và tài khoản không đi theo GitHub. Khóa Google/Facebook phải điền lại vào `server/.env` của máy đó, không gửi tệp `.env` qua tin nhắn hay email. Máy chưa có SMTP hoặc Ollama thì xem [mục 4](#4-chạy-thử-nhanh-không-cần-mongodb) để in email ra log và dùng check-in mô phỏng khi chạy thử.

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
- Mỗi lần khởi động, server dọn tệp tạm, chạy migration, đồng bộ câu chuyện (`server/src/data/stories.json`), bảo đảm có cấu hình Gacha, rồi in ra phương thức nào đang tắt / đang mô phỏng.
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

## 6. Cấu hình `server/.env`

Mẫu đầy đủ có chú thích từng biến: [`server/.env.example`](server/.env.example). **Không đưa `.env` vào mã nguồn** (đã nằm trong `.gitignore`).

Các biến cần quan tâm nhất:

| Biến | Ý nghĩa |
|---|---|
| `NODE_ENV` | `development` hoặc `production`. Production chặn mọi chế độ mô phỏng, email console và DB in-memory |
| `PORT` | Cổng API, mặc định `3001` |
| `MONGODB_URI` | Chuỗi kết nối MongoDB, mặc định `mongodb://127.0.0.1:27017/greencanteen` |
| `CLIENT_ORIGIN` | Địa chỉ giao diện (dùng cho CORS và điều hướng sau đăng nhập). Production: tên miền HTTPS cuối cùng, vì passkey gắn với tên miền này |
| `TRUST_PROXY` | Địa chỉ reverse proxy đứng trước server (vd. `loopback`). **Không** dùng `true` hay `*` |
| `COOKIE_SECURE`, `COOKIE_SAMESITE` | Cookie phiên. Tự bật `secure` khi production; client và API khác site thì `COOKIE_SAMESITE=none` + HTTPS |
| `EMAIL_TRANSPORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Gửi email. Thiếu SMTP thì **không đăng ký bằng email** và không dùng được "Quên mật khẩu". Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Đăng nhập Google (bỏ trống ID/secret thì nút báo "Chưa cấu hình"). Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_CALLBACK_URL` | Đăng nhập Facebook. Các bước: [mục 6.1](#61-nối-đăng-nhập-email-gmail-facebook) |
| `VISION_ENGINE` | `ensemble` (mặc định, CLIP + Ollama), `ollama`, `clip`, `off`. Production chỉ chạy `ensemble` |
| `VISION_OLLAMA_URL`, `VISION_OLLAMA_MODEL` | Địa chỉ Ollama (chỉ nhận loopback/mạng riêng) và mô hình |
| `VISION_CONFIDENCE_THRESHOLD`, `VISION_TIMEOUT_MS` | Ngưỡng tin cậy (mặc định 0.8); với `ensemble` nên đặt timeout 60000 |
| `CHECKIN_COOLDOWN_MINUTES` | Khoảng cách tối thiểu giữa hai check-in được thưởng; khuyến nghị 30+ khi chạy thật |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Máy chạy `clamd` để quét mã độc ảnh. Bỏ trống thì không quét |
| `ADMIN_MFA_KEY` | Khóa 32 byte cho khu quản trị và 2FA. Thiếu thì mọi `/api/admin` trả 503 |
| `AUTH_*`, `CAPTCHA_*`, `API_RATE_LIMIT_PER_MINUTE` | Giới hạn chống dò mật khẩu / đăng ký hàng loạt. Cả trường có thể dùng chung một IP NAT nên ngưỡng phải rộng; cách chọn: [mục 8.9](#89-chọn-ngưỡng-giới-hạn-theo-sĩ-số) |
| `ANALYTICS_ENABLED`, `ANALYTICS_HASH_KEY` | Thống kê truy cập ẩn danh cho khu quản trị |

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
| Email + mật khẩu | SMTP | `EMAIL_TRANSPORT=console`: liên kết xác minh nằm trong log của API, không có thư thật | SMTP thật |
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

Hai trang nằm ở `client/privacy.html`, `client/data-deletion.html`, là HTML tĩnh để trình thu thập đọc được mà không chạy JavaScript. Nội dung bám theo những gì mã nguồn đang làm nhưng **chưa qua tư vấn pháp lý**: người phụ trách nên đọc lại trước khi công khai. Thay đổi cách thu thập hay lưu dữ liệu thì sửa hai tệp này và ngày cập nhật, rồi build lại.

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

## 7. Hướng dẫn sử dụng

### 7.1. Sinh viên

Mở trang chủ (trên điện thoại có thể "Thêm vào màn hình chính" để dùng như ứng dụng).

1. **Đăng nhập / đăng ký**: vào trang **Cá nhân**, một popup hiện ra. Chọn email + mật khẩu, Google, Facebook, mã QR hoặc passkey.
   Đăng ký bằng email cần mở liên kết xác minh gửi qua email, rồi đặt mật khẩu.
2. **Check-in**: vào trang **Check-in**, chụp ảnh (hoặc tải ảnh lên) bình/ly nước cá nhân của bạn. Server nhận diện ảnh:
   - Là bình/ly cá nhân với độ tin cậy đủ cao: **+10 điểm** và **1 lượt Gacha**, kèm popup câu chuyện khoa học có nguồn.
   - Ly nhựa dùng một lần, vật chứa khác, ảnh không rõ hoặc không có vật chứa: không được thưởng.
3. **Gacha**: dùng lượt quay để nhận mã nạp (hiện là mã demo, xem [mục 11](#11-giới-hạn-hiện-tại)).
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

Trong khu quản trị: tổng quan số liệu, tài khoản (khóa/mở, đổi quyền, đặt lại MFA), câu chuyện (nháp → xuất bản), cấu hình Gacha theo phiên bản, thiết lập website, nhật ký kiểm toán.
Phiên quản trị ngắn (mặc định 15 phút nhàn rỗi, tối đa 8 giờ); thao tác nhạy cảm yêu cầu xác thực lại.

**Thêm admin khác:** Khu quản trị → Tài khoản → chọn tài khoản → **Cấp quyền quản trị**. Tài khoản phải có email và mật khẩu. Sau khi xác thực lại, màn hình hiện mã đăng ký MFA một lần, trao cho người đó qua kênh an toàn.

**Yêu cầu xóa dữ liệu:** Sinh viên gửi yêu cầu theo trang `/data-deletion.html`. Đối chiếu thẻ sinh viên để chắc đúng chủ tài khoản, rồi chạy trên máy chủ:

```bash
cd server
npm run admin:delete-user -- --student-id <mã sinh viên>
```

Lệnh in tài khoản sắp xóa và số dữ liệu, rồi bắt gõ lại mã sinh viên. Lệnh xóa tài khoản, ảnh đại diện, check-in, mã nạp, phiên đăng nhập, passkey, 2FA và **không hoàn tác được**. Tài khoản quản trị phải gỡ quyền trước. Nhật ký kiểm toán được giữ lại, bản sao lưu cũ vẫn còn dữ liệu cho tới khi bị ghi đè. Trang đã cam kết xóa trong 30 ngày, nên xong việc hãy báo lại cho người yêu cầu.

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
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev   # bỏ ONNXRUNTIME_NODE_INSTALL nếu có GPU và muốn dùng
npm run vision:download && npm run vision:verify
```

Tạo `server/.env` cho production (tối thiểu):

```
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb://<user>:<pass>@<host>:27017/greencanteen
CLIENT_ORIGIN=https://greencanteen.truong.edu.vn
TRUST_PROXY=loopback

VISION_ENGINE=ensemble
VISION_OLLAMA_URL=http://127.0.0.1:11434
VISION_OLLAMA_MODEL=qwen3-vl:4b-instruct
VISION_TIMEOUT_MS=60000
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

### 8.2. Ollama (nhận diện ảnh)

Production cần `ensemble` nên phải có Ollama:

```bash
ollama pull qwen3-vl:4b-instruct
```

- Ollama **không có xác thực**: chỉ cho chạy cùng máy với API (`127.0.0.1`) hoặc trong mạng riêng có tường lửa chỉ cho máy API vào cổng 11434.
- Trên máy Ollama đặt `OLLAMA_NO_CLOUD=1` (và `OLLAMA_KEEP_ALIVE=-1` để mô hình không bị gỡ khỏi bộ nhớ) để ảnh không thể bị gửi lên dịch vụ cloud của Ollama.
- Không dùng mô hình cloud (tag `:cloud`). Server tự tắt check-in nếu phát hiện.
- Trước khi mở cho sinh viên, đánh giá bằng ảnh thật rồi chọn ngưỡng: `npm run vision:evaluate` (trong `server/`).
- Ảnh có cạnh dài trên 1024 px được thu nhỏ trước khi gửi cho Ollama, ảnh nhỏ hơn giữ nguyên, nên ảnh chụp 12 MP không tốn thêm thời gian.

**Phần cứng:** nên có GPU. Ảnh được thưởng cần hai lượt gọi Ollama (ảnh gốc và ảnh làm mờ chữ). Ollama xử lý từng ảnh một, và thời gian xếp hàng cũng tính vào `VISION_TIMEOUT_MS`. 

| Máy | Một lượt gọi | Một check-in được thưởng | Ghi chú |
|---|---|---|---|
| GPU RTX 4060 Laptop | ~1,5 giây | ~3,6 giây | |
| CPU 8 lõi thật | ~40 giây | ~80 giây | Khoảng 2 người cùng lúc |
| CPU 4 lõi thật | ~72 giây | 149–166 giây | Mức tối thiểu. Người thứ hai cùng lúc có thể bị timeout |
| CPU 2 lõi thật | ~143 giây | Không chạy được | Vượt trần 120 giây nên check-in luôn báo quá thời gian |

Không có GPU thì đặt `VISION_TIMEOUT_MS=120000`. Máy cloud tính theo vCPU, thường 2 vCPU mới bằng 1 lõi thật, nên hãy đo trên đúng máy đó trước khi chọn.

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

Kết quả nằm ở `client/dist/`, gồm `index.html` (sinh viên), `admin/index.html` (quản trị) và hai trang tĩnh `privacy.html`, `data-deletion.html`. Chép thư mục này tới máy chủ web.

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
3. Đăng ký thử một tài khoản (kiểm SMTP), check-in thử một ảnh thật (kiểm CLIP + Ollama), đăng nhập `/admin`.
4. Đăng nhập sai một lần từ máy ngoài, kiểm tra `db.ratelimits.find({ key: /^login-fail-ip:/ })` có đúng IP thật (kiểm `TRUST_PROXY`).

### 8.7. Danh sách kiểm tra production

- [ ] HTTPS, `NODE_ENV=production`, `CLIENT_ORIGIN` đúng tên miền cuối cùng (đổi sau này thì mọi passkey mất tác dụng).
- [ ] `TRUST_PROXY` là địa chỉ proxy thật, không phải `true`/`*`; ngưỡng `AUTH_*_IP_MAX` và `API_RATE_LIMIT_PER_MINUTE` hợp với sĩ số trường.
- [ ] SMTP đã cấu hình; tên miền gửi thư có SPF, DKIM, DMARC.
- [ ] Đã đặt **Thông tin liên hệ hỗ trợ** và đọc lại `/privacy.html`, `/data-deletion.html` theo đúng cách vận hành của trường.
- [ ] `VISION_ENGINE=ensemble`, mô hình CLIP và Ollama sẵn sàng, Ollama không mở ra ngoài mạng riêng.
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

Không gói miễn phí nào chạy được **toàn bộ** hệ thống trên cloud: check-in ở production cần cả CLIP lẫn Ollama. Trên Windows, API production dùng ~109 MB RAM khi tắt nhận diện, nhưng 466 MB ngay sau khi nạp CLIP, chưa xử lý ảnh nào và chưa tính Ollama (mô hình ~3,3 GB). Render Free chỉ có 512 MB và 0,1 CPU.

| | Cách 1: Local + Cloudflare Tunnel | Cách 2: Render + MongoDB Atlas |
|---|---|---|
| Check-in bằng ảnh | **Có** (CLIP + Ollama thật) | **Không**, API trả 503. Điểm, Gacha từ check-in cũng không phát sinh |
| Địa chỉ | `*.trycloudflare.com`, đổi mỗi lần mở tunnel | `*.onrender.com`, cố định |
| Truy cập được khi | Máy bật và đủ các tiến trình đang chạy | Mọi lúc; ngủ sau 15 phút không có truy cập, lần đầu chờ ~1 phút |
| Nên dùng khi | Buổi demo cần chạy đủ luồng | Cần link cố định để xem giao diện, đăng nhập, bảng xếp hạng, khu quản trị |

Cả hai đều **chỉ để demo**, không đạt [danh sách production](#87-danh-sách-kiểm-tra-production): không có ClamAV nên log luôn có dòng `Cấu hình chưa an toàn: CLAMAV_HOST`, ảnh tải lên không được quét mã độc. Điều khoản gói miễn phí hay đổi.

**Không làm** mấy việc sau để "chữa cháy" check-in trên cloud:

- Đặt `NODE_ENV=development` để bật `VISION_SIMULATION`: cookie mất `Secure`, và ảnh nào cũng được chấm là hợp lệ.
- Mở Ollama ở nhà ra Internet rồi đặt `VISION_OLLAMA_TRUSTED_HOST=true`: Ollama không có xác thực.

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

#### Cách 1: Local + Cloudflare Tunnel

Cần `npm run setup` đã chạy xong và đủ mô hình CLIP, Ollama. MongoDB và Ollama vẫn chỉ nghe `127.0.0.1`, Internet chỉ tới được Caddy qua tunnel.

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

3. Bật MongoDB bằng `start-mongodb.cmd`, bật Ollama, tắt `dev:server` để trống cổng 3001. Rồi build giao diện (làm lại mỗi khi đổi mã client):

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
   $env:VISION_ENGINE = "ensemble"
   $env:VISION_TIMEOUT_MS = "60000"
   $env:CHECKIN_COOLDOWN_MINUTES = "30"
   npm start
   ```

5. Tạo admin nếu chưa có ([mục 7.3](#73-quản-trị-viên)), mở `https://<địa chỉ tunnel>/api/health` rồi thử check-in một ảnh thật.

Lưu ý:

- Mỗi lần mở lại tunnel địa chỉ đổi: chạy lại API với `CLIENT_ORIGIN` mới. Passkey và callback Google/Facebook gắn với địa chỉ cũ sẽ mất tác dụng, nên buổi demo dùng email + mật khẩu hoặc mã QR. Muốn địa chỉ cố định phải có tên miền riêng trên Cloudflare và tạo tunnel có tên.
- Quick Tunnel chỉ dành cho thử nghiệm: tối đa 200 yêu cầu đồng thời, không cam kết hoạt động liên tục.
- Không chạy game hay ứng dụng nặng GPU trong lúc demo, Ollama có thể treo làm check-in báo lỗi.
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
   MONGODB_URI=<chuỗi Atlas>
   CLIENT_ORIGIN=https://greencanteen.onrender.com
   TRUST_PROXY=1
   VISION_ENGINE=off
   ADMIN_MFA_KEY=<khóa mới>
   ANALYTICS_HASH_KEY=<khóa mới khác>
   ```

   Log sẽ có cảnh báo về `TRUST_PROXY=1`: chấp nhận được vì cổng API trên Render không mở trực tiếp ra ngoài.

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

## 9. Kiểm thử

Test không cần tài khoản hay khóa thật: MongoDB in-memory riêng; Ollama, Google, Facebook, SMTP đều được giả lập. Từ thư mục gốc:

| Lệnh | Việc làm |
|---|---|
| `npm test` | Unit + integration của server, rồi unit + UI của client |
| `npm run test:e2e` | Kiểm thử hệ thống bằng Playwright (Edge/Chrome cài sẵn trong máy). Tự chạy API thử ở cổng 3101 và Vite ở 5174, không đụng server dev |
| `npm run test:e2e:build` | Kiểm bản build thật: CSP, service worker, robots |
| `npm run coverage` | Độ phủ C0/C1/C2 → `server/coverage/`, `client/coverage/` |

Test nhận diện bằng CLIP/VLM thật chỉ chạy khi đã có mô hình trong `server/models/` và Ollama trong máy, không thì tự bỏ qua.

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Vite báo `ECONNRESET` / `ECONNREFUSED` | API không chạy, đang khởi động lại, hoặc cổng 3001 bị tiến trình khác chiếm (server báo « Cổng 3001 đang được tiến trình khác dùng »). Chỉ chạy một API trên cổng 3001 |
| Mọi tài khoản biến mất sau khi khởi động lại | Đang dùng DB in-memory (không kết nối được MongoDB). Chạy MongoDB thật và đặt `MONGODB_URI` |
| Server không khởi động, "Không kết nối được MongoDB" | Chưa bật MongoDB: chạy `start-mongodb.cmd` trong thư mục cài MongoDB. Đã đặt `MONGODB_URI` hoặc chạy production thì server không tự dùng DB tạm. Kiểm tra `MONGODB_URI`, mạng, tài khoản |
| Check-in báo "chưa sẵn sàng" (503) | Thiếu mô hình CLIP (`npm run vision:download`), Ollama chưa chạy / chưa `pull` mô hình, hoặc `VISION_ENGINE` không hợp lệ cho production. Xem log khởi động |
| Check-in báo "máy chủ đang bận" | Quá `VISION_MAX_QUEUE` ảnh chờ nhận diện; tăng tài nguyên hoặc giảm tải |
| Check-in báo "mất quá nhiều thời gian" | Ollama chạy trên CPU quá chậm, đang xếp hàng, hoặc GPU bị game/ứng dụng khác chiếm. Không có GPU thì đặt `VISION_TIMEOUT_MS=120000` và xem bảng phần cứng ở [mục 8.2](#82-ollama-nhận-diện-ảnh) |
| Tab "Tạo tài khoản" hoặc "Quên mật khẩu" báo "Chưa cấu hình" | Chưa có `SMTP_HOST` / `EMAIL_FROM`. Khi phát triển dùng `EMAIL_TRANSPORT=console` |
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

- Mã nạp Gacha hiện là mã demo, chưa xác minh đổi được tại nhà mạng; cần tích hợp đối tác nạp thật trước khi dùng thật.
