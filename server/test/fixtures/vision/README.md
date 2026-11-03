Ảnh **vẽ tổng hợp** (SVG → JPEG 448×448) dùng cho test bộ nhận diện thật — không phải ảnh chụp, không dùng để đo độ
chính xác. `plastic-cup-thermos-label.jpg` mô phỏng tấn công bằng chữ trong ảnh (ly nhựa dán nhãn "THERMOS", F-26).

`adversarial/` và `adversarial-holdout/` là tập đối kháng của F-26, sinh bằng `adversarial/generate.mjs`, mỗi tập 78 ảnh: 46 ảnh vật chứa dùng
một lần gắn chữ đánh lừa hoặc chỉ có chữ, 7 ảnh đối chứng không chữ, 25 ảnh bình/ly tái sử dụng (20 ảnh có nhãn). `manifest.json` ghi loại, bố cục,
từ ngữ và SHA-256 của từng ảnh. Thư mục con đặt theo loại đúng nên dùng được với `npm run vision:evaluate`.

`adversarial/` đã được dùng khi thiết kế biện pháp nên không phải bằng chứng độc lập. `adversarial-holdout/` chỉ để chấm sau khi chốt thiết kế: dùng nó để
tinh chỉnh thì phải sinh tập holdout mới.
