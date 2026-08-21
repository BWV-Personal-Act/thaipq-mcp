# MCP File Organizer — demo cho bài techblog "MCP in Practice"

Demo minh họa MCP qua use case "AI File Organization Assistant": một MCP Server expose 2 tool quản lý file (`list_files`, `move_file` — không có `read_file`, server không bao giờ đọc nội dung bên trong file, chỉ dùng tên file/phần mở rộng/ngày sửa đổi), và một MCP Client/Agent dùng Gemini (qua `@google/genai`, hỗ trợ MCP có sẵn bằng `mcpToTool`) để tự chọn tool cần gọi dựa trên yêu cầu tự nhiên của người dùng. `folder` là đường dẫn tuyệt đối bất kỳ trên máy (không riêng gì `storage/inbox` của demo — có thể trỏ sang một thư mục thật như Downloads), kết quả luôn nằm trong `<folder>/organized/<phần mở rộng>/<năm>/<tháng>/<ngày>/`. Dataset demo là 500 file mock, tích lũy qua 365 ngày, tổ chức lại theo phần mở rộng rồi theo năm/tháng/ngày sửa đổi cuối.

## Cài đặt

```bash
npm install
```

## Sinh dữ liệu mock

```bash
npm run generate-mock   # sinh 500 file mock vào storage/inbox, mtime rải rác trong 365 ngày gần nhất
```

Chạy lại lệnh này để sinh một bộ dữ liệu mới bất kỳ lúc nào.

## Chạy Agent thật (cần API key Gemini)

`client/client.ts` là Agent thật: gửi tên MCP client cho Gemini qua `mcpToTool`, để Gemini tự quyết định gọi tool nào với argument gì (automatic function calling), không hard-code rule nào. Đọc key từ `GEMINI_API_KEY`, hoặc `GOOGLE_API_KEY`, hoặc `API_KEY` (theo thứ tự ưu tiên đó); đọc model từ `MODEL` nếu giá trị bắt đầu bằng `gemini-`, ngược lại dùng mặc định `gemini-2.5-flash`.

```bash
# PowerShell
$env:GEMINI_API_KEY = "AIza..."
npm run agent
```

```bash
# bash
export GEMINI_API_KEY="AIza..."
npm run agent
```

Cũng có thể đặt các biến này trong file `.env` ở thư mục project; `npm run agent` tự nạp `.env` nếu file tồn tại (dùng flag `--env-file-if-exists` của Node).

Muốn thử trên một thư mục thật thay vì `storage/inbox`, truyền đường dẫn tuyệt đối làm argument, ví dụ `npm run agent -- "C:\Users\you\Downloads"`.

## An toàn khi dùng với dữ liệu thật

`server.ts` chặn sẵn vài trường hợp trước khi đụng tới filesystem:

- `folder` phải là đường dẫn tuyệt đối — truyền tương đối bị từ chối ngay, không âm thầm resolve theo cwd của tiến trình server.
- `name` phải là tên file trần (không chứa `/`, `\`, hay `..`) — chặn traversal ra ngoài `folder`.
- `to_folder` được resolve rồi kiểm tra lại phải nằm trong `<folder>/organized/` — chặn traversal thoát ra ngoài qua `..`.
- `move_file` từ chối nếu đích đã tồn tại (không âm thầm ghi đè); truyền `dry_run: true` để xem trước sẽ move gì mà không đụng file thật.
- Đặt biến môi trường `ALLOWED_ROOTS` (danh sách đường dẫn tuyệt đối, phân tách bằng `;` trên Windows hoặc `:` trên Unix — theo `path.delimiter`) để giới hạn `folder` chỉ được nằm trong các gốc đó. Không đặt thì giữ hành vi gốc của demo: nhận bất kỳ thư mục tuyệt đối nào — phù hợp để demo nhưng nên đặt `ALLOWED_ROOTS` khi trỏ vào dữ liệu thật.

## Cấu trúc

```
server/server.ts               MCP Server: list_files, move_file — folder là đường dẫn tuyệt đối bất kỳ, không đọc nội dung file
client/generate-mock-inbox.ts  Sinh 500 file mock vào storage/inbox
client/client.ts               MCP Client + Agent, dùng Gemini qua @google/genai
storage/                       Sinh ra khi chạy generate-mock, không commit vào repo
```
