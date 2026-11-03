// Giả terminal cho dấu nhắc ẩn của admin-cli: stdin vẫn là pipe nhưng báo là TTY, để test đi đúng nhánh người dùng thật gặp
process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
