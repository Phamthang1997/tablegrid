# Kế hoạch Phát triển & Lộ trình Tính năng Mới cho TABLEGRID

Tài liệu này tổng hợp phân tích kiến trúc, thiết kế UX/UI và giải pháp kỹ thuật cho các tính năng tiếp theo nhằm nâng tầm TABLEGRID trở thành một Database Client chuyên nghiệp hàng đầu (sánh ngang TablePlus, DataGrip, DBeaver).

---

## 📌 Tổng quan các tính năng đề xuất

| STT | Tính năng | Mục tiêu | Độ ưu tiên |
|:---|:---|:---|:---:|
| **1** | **Tự động cập nhật ứng dụng (Tauri Auto-Updater)** | Giúp người dùng nhận bản cập nhật mới tự động qua GitHub Releases mà không cần tải lại file `.exe`/`.dmg` thủ công. | **P0 (Cao nhất)** |
| **2** | **Tích hợp MCP Server nội bộ (Built-in Model Context Protocol)** | Mở Local MCP Server (127.0.0.1) cho phép Cursor, Claude Desktop, Raycast truy vấn database qua TABLEGRID có bảo vệ. | **P0 (Cao nhất)** |
| **3** | **Sơ đồ quan hệ bảng trực quan (Interactive ER Diagram)** | Quét và trực quan hóa cấu trúc bảng, khóa ngoại (Foreign Keys) thành sơ đồ node tương tác, zoom/pan và xuất ảnh. | **P1** |
| **4** | **Giám sát thời gian thực & Hủy truy vấn (Live Processlist & Kill Query)** | Giám sát các truy vấn đang chạy trên PostgreSQL/MySQL, phát hiện khóa (Locks) và hủy truy vấn bị treo với 1-click. | **P1** |
| **5** | **Trực quan hóa kết quả truy vấn (Query Result Charts)** | Chuyển đổi bảng kết quả `SELECT` thành biểu đồ (Bar, Line, Pie, Area) trực tiếp trong SQL Editor. | **P2** |
| **6** | **Mở rộng định dạng xuất dữ liệu (Excel `.xlsx`, Copy Markdown)** | Xuất kết quả ra file Excel định dạng chuẩn và copy nhanh hàng loạt dòng dưới dạng bảng Markdown / JSON Array. | **P2** |
| **7** | **Tích hợp DuckDB & Quét file Parquet/CSV cục bộ** | Hỗ trợ phân tích dữ liệu cục bộ siêu tốc từ file mà không cần cài đặt database server. | **P3** |

---

## 1. 🔄 Chi tiết Kỹ thuật: Tự động cập nhật (Tauri Auto-Updater)

### 1.1. Hiện trạng & Nhu cầu
- **Hiện tại**: Chưa cấu hình plugin `@tauri-apps/plugin-updater`. Khi có release mới (ví dụ `0.1.2`), người dùng bị kẹt ở bản cũ `0.1.1` trừ khi vào web tải lại thủ công.
- **Mục tiêu**: Khi mở app hoặc bấm *"Kiểm tra bản cập nhật"*, app tự động hỏi GitHub Releases xem có bản mới không, hiển thị changelog và tự tải + cài đặt trong vài giây.

### 1.2. Luồng hoạt động (Workflow)
1. **Bảo mật (Chữ ký số - Signing)**:
   - Sinh cặp khóa: `npx @tauri-apps/cli signer generate -w ~/.tauri/TABLEGRID.key`.
   - **Public Key**: Đưa vào file `tauri.conf.json`.
   - **Private Key**: Lưu vào GitHub Actions Secrets (`TAURI_SIGNING_PRIVATE_KEY`).
2. **Khi Build Release trên GitHub Actions**:
   - Khi tạo GitHub Tag (`v0.1.2`), GitHub Actions tự động build các target (Windows `.exe`/`.msi`, macOS `.dmg`/`.app`).
   - Tự động sinh file `latest.json` chứa: version, link download, changelog, signature hash và publish lên GitHub Release.
3. **Trong ứng dụng TABLEGRID**:
   - Khởi động app ➔ gọi `check()` từ `@tauri-apps/plugin-updater`.
   - Nếu có bản mới ➔ hiện banner/modal thông báo với changelog.
   - Bấm **Cập nhật ngay** ➔ gọi `update.downloadAndInstall()` ➔ hiển thị thanh tiến trình ➔ tự khởi động lại app.

### 1.3. Cấu hình cần thêm
- Thêm dependency trong `src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"`.
- Thêm cấu hình trong `src-tauri/tauri.conf.json`:
  ```json
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_STRING",
      "endpoints": [
        "https://github.com/Phamthang1997/TABLEGRID/releases/latest/download/latest.json"
      ]
    }
  }
  ```
- Tạo UI component `src/components/UpdateNotificationModal.tsx` hoặc banner cập nhật trên thanh tiêu đề (TitleBar).

---

## 2. 🗺️ Chi tiết Kỹ thuật: Sơ đồ quan hệ bảng (Interactive ER Diagram)

### 2.1. Hiện trạng & Nhu cầu
- App đã có API lấy toàn bộ danh mục metadata (`get_full_catalog`, `get_table_schema`, danh sách Foreign Keys / Constraints), nhưng chưa có màn hình hiển thị trực quan quan hệ giữa các bảng.

### 2.2. Kiến trúc giải pháp
1. **Frontend Visualizer Canvas**:
   - Tận dụng `React Flow` (`@xyflow/react`) hoặc Canvas/SVG renderer riêng để đảm bảo hiệu năng và không phụ thuộc CSS nặng.
   - Mỗi **Table Node** hiển thị:
     - Header: Tên bảng, icon loại bảng (Base Table / View), màu sắc dialect.
     - Body: Danh sách cột, kiểu dữ liệu, biểu tượng khóa chính (PK 🔑), khóa ngoại (FK 🔗), chỉ mục (Index).
2. **Auto-Layout Algorithm**:
   - Áp dụng thuật toán Dagre / Elk layout để tự động sắp xếp các bảng khoa học, hạn chế đường nối chéo nhau.
   - Cho phép người dùng kéo thả (drag & drop) sắp xếp vị trí và lưu layout vào `localStorage` theo từng database.
3. **Tính năng tương tác**:
   - Rê chuột vào đường nối FK: Highlight 2 cột tương ứng của 2 bảng liên kết.
   - Click đúp vào bảng: Mở nhanh tab dữ liệu `DataGrid` của bảng đó.
   - Xuất sơ đồ: Nút xuất file ảnh PNG chất lượng cao hoặc SVG vector.

---

## 3. 🚦 Chi tiết Kỹ thuật: Giám sát tiến trình thời gian thực (Live Processlist & Kill Query)

### 3.1. Hiện trạng & Nhu cầu
- Khi làm việc với database lớn, nhiều truy vấn chạy nặng hoặc bị khóa hàng (Row Lock / Deadlock) làm nghẽn server. Hiện tại TABLEGRID chưa có công cụ để quản trị viên phát hiện và ngắt truy vấn này.

### 3.2. Kiến trúc giải pháp
1. **Backend Rust Handlers**:
   - **PostgreSQL**:
     - Truy vấn `pg_stat_activity` lấy: `pid`, `usename`, `client_addr`, `state`, `query_start`, `wait_event_type`, `query`.
     - Lệnh ngắt: `SELECT pg_cancel_backend(pid)` (hủy truy vấn) hoặc `SELECT pg_terminate_backend(pid)` (ngắt kết nối).
   - **MySQL**:
     - Truy vấn `SHOW FULL PROCESSLIST` hoặc `information_schema.PROCESSLIST`.
     - Lệnh ngắt: `KILL QUERY <id>` hoặc `KILL CONNECTION <id>`.
   - **SQLite**: Kiểm tra trạng thái khóa file / WAL mode.
2. **Frontend UI Monitor (`ProcessListModal.tsx`)**:
   - Bảng danh sách phiên kết nối với auto-refresh (1s, 3s, 5s, Dừng).
   - Đánh dấu màu cảnh báo: Truy vấn chạy > 10s (Vàng), truy vấn bị Lock/Blocked (Đỏ).
   - Nút **"Kill Query"** và **"Kill Session"** có bảo vệ qua Safe Mode Gate.

---

## 4. 📊 Chi tiết Kỹ thuật: Trực quan hóa kết quả truy vấn (Query Result Charts)

### 4.1. Hiện trạng & Nhu cầu
- Kết quả câu lệnh `SELECT` trong `SqlEditor.tsx` hiện chỉ có dạng bảng chữ/số (`DataGrid`). Khi viết các câu lệnh phân tích (Group By, Sum, Count), người dùng muốn xem biểu đồ ngay.

### 4.2. Kiến trúc giải pháp
1. **Thêm Tab chuyển đổi trong SqlEditor**:
   - `[ 📋 Table View ]` | `[ 📊 Chart View ]`
2. **Chart Renderer & Tự động cấu hình**:
   - Tích hợp thư viện chart nhẹ (như `Chart.js` + `react-chartjs-2` hoặc `ECharts`).
   - Tự động phát hiện:
     - Cột chữ/thời gian ➔ gán làm trục hoành (X-Axis / Category).
     - Cột số (`INT`, `FLOAT`, `DECIMAL`) ➔ gán làm trục tung (Y-Axis / Value Series).
   - Cho phép người dùng chọn loại biểu đồ: **Cột (Bar)**, **Đường (Line)**, **Tròn (Pie)**, **Vùng (Area)**, **Phân tán (Scatter)**.
   - Nút **"Save Chart as Image"** (PNG).

---

## 5. 📑 Chi tiết Kỹ thuật: Mở rộng định dạng xuất dữ liệu

### 5.1. Xuất file Excel (`.xlsx`)
- Thêm tùy chọn xuất trực tiếp ra file Excel trong `ExportTableDialog` và thanh công cụ của `DataGrid`.
- Tự động định dạng Header in đậm, freeze pane dòng tiêu đề, định dạng đúng kiểu số và ngày tháng.

### 5.2. Sao chép nhanh (Quick Copy Actions) trong DataGrid
- Bôi đen nhiều ô/dòng ➔ Chuột phải:
  - **Copy as Markdown Table**: `| id | name | price | ...`
  - **Copy as JSON Array**: `[{"id": 1, "name": "Item A"}, ...]`
  - **Copy as SQL INSERT Statements**: `INSERT INTO table (id, name) VALUES (1, 'Item A');`

---

## 6. 📅 Kế hoạch Triển khai theo Giai đoạn (Phases)

> **Trạng thái soát ngày 2026-09-04.** 5/7 mục dưới đây đã có code thật nhưng ô tick vẫn để trống,
> nên tài liệu này từng đọc như thể chưa làm gì. Chỉ còn Auto-Updater và DuckDB là chưa bắt đầu.

### Giai đoạn 1: Trải nghiệm & Phân phối (P0)
- [ ] Cấu hình **Tauri Auto-Updater** (`tauri-plugin-updater`) & GitHub Actions workflow cho release tự động. — CHƯA có: không có chữ `updater` nào trong `package.json`, `Cargo.toml` hay `tauri.conf.json`.
- [x] Bổ sung tính năng **Quick Copy** (Markdown, JSON, SQL INSERT) vào menu chuột phải DataGrid. — `DataGrid.tsx` (`copyRowAsCSV/SQL/Markdown/Json`, menu chuột phải).

### Giai đoạn 2: Trực quan & Giám sát (P1)
- [x] Xây dựng màn hình **Live Processlist & Kill Query** cho MySQL và PostgreSQL. — `LiveProcessListModal.tsx` + `LiveProcessListPanel.tsx`.
- [x] Phát triển module **Interactive ER Diagram** trực quan hóa quan hệ bảng. — `src/components/er/` (layout engine, minimap, xuất ảnh, lưu vị trí node).

### Giai đoạn 3: Phân tích & Tiện ích mở rộng (P2 - P3)
- [x] Tích hợp **Query Result Charts** vào SQL Editor. — `src/components/chart/`, chuyển Grid ⇄ Chart theo TỪNG result tab trong `SqlEditor.tsx`.
- [x] Hỗ trợ xuất file **Excel (.xlsx)**. — `utils/xlsxWriter.ts` (tự viết, không thêm dependency), nối vào `exportHelper.ts`.
- [ ] Nghiên cứu tích hợp **DuckDB / Parquet** cho phân tích file dữ liệu cục bộ.
