# Kế hoạch Thiết kế & Phát triển: Table Properties (Workspace Tab) & Temporary Tables Sidebar Section

> **Tài liệu đặc tả kiến trúc & kế hoạch thực hiện (implementation_plan18)**  
> **Tính năng:**  
> 1. Xem thuộc tính chi tiết của bảng (Table Properties) dưới dạng một Tab trong workspace (`DataGrid`)  
> 2. Mục Bảng tạm (Temporary Tables) trên Sidebar, tự động hiển thị khi session sở hữu ít nhất 1 bảng tạm và tự dọn dẹp khi kết thúc session.

---

## 1. Mục tiêu & Nguyên lý thiết kế

### 1.1. Table Properties dưới dạng Workspace Tab
- **Vị trí**: Tích hợp trực tiếp vào thanh chế độ của `DataGrid` cạnh các chế độ hiện có:
  `[ Dữ liệu (Data) | Cấu trúc (Structure) | Biểu đồ (Chart) | Thuộc tính (Properties) ]`
- **Kích hoạt từ Sidebar**: Chuột phải vào bất kỳ bảng hoặc view nào trong Sidebar → chọn **Properties...** (Thuộc tính) → Chuyển hoặc mở tab bảng đó với `initialViewMode = 'properties'`.
- **Trải nghiệm đa nhiệm (Tab-based)**: Người dùng có thể mở song song nhiều tab để đối chiếu thuộc tính của các bảng khác nhau mà không bị che khuất màn hình như popup modal truyền thống.
- **Nội dung hiển thị**:
  1. **Tổng quan (Overview & Identification)**: Tên bảng, schema, loại bảng (BASE TABLE / VIEW / TEMPORARY), storage engine, row format, collation & charset, mô tả / comment, tablespace hoặc đường dẫn file vật lý.
  2. **Dung lượng & Lưu trữ (Storage & Sizes)**: Tổng dung lượng (Total size), Data size, Index size, Free space (overhead / fragmentation), dung lượng trung bình mỗi dòng (Avg row length), giá trị Auto-increment tiếp theo.
  3. **Số dòng & Bộ đếm (Row Counts)**: Số dòng ước tính nhanh (Estimated rows) + Nút đếm chính xác (`Count Exact Rows`) kèm spinner thời gian thực, không gây treo giao diện.
  4. **Cột & Ràng buộc (Columns & Keys)**: Số lượng cột, danh sách khóa chính (PK badges), số lượng và danh sách index, số lượng foreign keys (liên kết đi & liên kết đến).
  5. **Bảo trì & Thời gian (Maintenance & Timestamps)**: Thời gian tạo (Create time), thời gian cập nhật (Update time), số liệu vacuum/analyze (PostgreSQL), live/dead tuples.
  6. **Câu lệnh DDL (Definition)**: Mã `CREATE TABLE` đầy đủ kèm highlight cú pháp và nút 1-click **Copy DDL**.

### 1.2. Mục Temporary Tables trên Sidebar
- **Nguyên tắc hiển thị**:
  - Chỉ xuất hiện trên Sidebar **khi và chỉ khi session kết nối hiện tại sở hữu ít nhất 1 bảng tạm** (`filteredTempTables.length > 0`).
  - Khi số lượng bảng tạm về 0, mục này tự động ẩn hoàn toàn.
  - Khi ngắt kết nối / đóng session, danh sách bảng tạm tự động được giải phóng khỏi state.
- **Nguồn dữ liệu phiên làm việc từ engine (Engine's own view of the session)**:
  - **PostgreSQL**: Truy vấn schema `pg_temp` (schema riêng biệt của session trong `pg_class` và `pg_namespace`).
  - **MySQL**: Truy vấn `INFORMATION_SCHEMA.INNODB_TEMP_TABLE_INFO`.
  - **SQL Server**: Truy vấn `tempdb.sys.tables`.
  - **SQLite**: Truy vấn `sqlite_temp_master`.
- **Thao tác tương đương bảng thông thường**:
  - Click mở xem dữ liệu (`DataGrid`).
  - Xem cấu trúc cột/khóa (`StructureViewer`).
  - Xem thuộc tính bảng (`TablePropertiesView`).
  - Chuột phải mở menu ngữ cảnh (Open Data, Open Structure, Table Properties, Drop).

---

## 2. Quy chuẩn Kỹ thuật (Tuân thủ nghiêm ngặt AGENTS.md)

1. **CSS & Styling Rules**:
   - **Không sử dụng inline CSS** (`style={{ ... }}`).
   - 100% các class styling được định nghĩa tập trung trong file `src/components/table_properties.css`.
   - Ngoại lệ duy nhất là các giá trị tính toán động theo thời gian thực (như tọa độ chuột, progress bar động).
2. **UI & Button Design Rules**:
   - Mọi nút bấm (Mode tabs, Toolbar actions, Copy buttons) phải tuân thủ chuẩn nút độc lập của TableGrid: `1px solid var(--win-border)`, `border-radius: 6px`, nền trong suốt, hiệu ứng hover/active đổi sang `var(--win-accent)`.
   - **Tuyệt đối không nhóm các nút vào container capsule/pill dính liền kiểu segmented control của iOS**.
3. **Rust Module Structure (`src-tauri`)**:
   - Các lệnh kiểm tra stats và properties đặt tại `src-tauri/src/stats/table_properties.rs`.
   - Các lệnh liên quan đến database introspection đặt tại `src-tauri/src/database/introspect.rs`.
   - Đăng ký đầy đủ tại `src-tauri/src/app/handlers.rs`.
4. **Quy chuẩn mã nguồn**:
   - Toàn bộ comment, tên hàm, tên biến, commit message và PR bằng tiếng Anh.

---

## 3. Thiết kế Chi tiết Backend (Rust `src-tauri`)

### 3.1. `src-tauri/src/stats/table_properties.rs`
Hàm xử lý chính:
```rust
#[tauri::command]
pub async fn get_table_properties(conn_id: String, table_name: String) -> Result<Value, String>
```

#### Thuật toán trích xuất theo từng Dialect:
1. **MySQL / MariaDB**:
   - Query `information_schema.TABLES` lấy các trường:
     `TABLE_TYPE`, `ENGINE`, `ROW_FORMAT`, `TABLE_ROWS`, `AVG_ROW_LENGTH`, `DATA_LENGTH`, `INDEX_LENGTH`, `DATA_FREE`, `AUTO_INCREMENT`, `CREATE_TIME`, `UPDATE_TIME`, `CHECK_TIME`, `TABLE_COLLATION`, `TABLE_COMMENT`, `CREATE_OPTIONS`.
   - Query đếm cột từ `information_schema.COLUMNS`.
   - Query danh sách cột khóa chính từ `information_schema.KEY_COLUMN_USAGE`.
   - Query số lượng index từ `SHOW INDEX FROM ...`.
   - Lấy DDL từ `SHOW CREATE TABLE ...`.
2. **PostgreSQL**:
   - Query `pg_class`, `pg_namespace`, `pg_tablespace`, `pg_description`:
     - `relkind` ('r' = BASE TABLE, 'v' = VIEW, 'm' = MATVIEW, 'p' = PARTITIONED, v.v.).
     - `reltuples` (số dòng ước lượng).
     - Kích thước: `pg_total_relation_size(c.oid)`, `pg_relation_size(c.oid)`, `pg_indexes_size(c.oid)`.
     - `tablespace`: tên tablespace hoặc 'default'.
     - `relpersistence`: permanent / unlogged / temporary.
     - `comment`: mô tả bảng từ `pg_description`.
   - Query thống kê vận hành từ `pg_stat_user_tables`:
     `n_live_tup`, `n_dead_tup`, `seq_scan`, `idx_scan`, `last_vacuum`, `last_analyze`.
   - Cột & Khóa chính từ `pg_attribute` và `pg_constraint`.
   - Hỗ trợ cả bảng thông thường và bảng tạm nằm trong schema `pg_temp%`.
3. **SQLite**:
   - Query `sqlite_master` và `sqlite_temp_master`: lấy `type` và `sql` (chính là DDL gốc).
   - PRAGMA `table_info`: đếm cột, nhận diện khóa chính.
   - PRAGMA `index_list`: đếm index.
   - PRAGMA `foreign_key_list`: đếm foreign key.
   - PRAGMA `database_list`: lấy đường dẫn file cơ sở dữ liệu trên ổ cứng.
   - `sqlite_sequence`: lấy giá trị auto_increment hiện tại.
   - Đếm dòng nhanh: `SELECT COUNT(*) FROM ...`.

### 3.2. `src-tauri/src/database/introspect.rs`
Hàm xử lý lấy danh sách bảng tạm:
```rust
pub(crate) async fn get_temporary_tables_inner(
    state: &crate::AppState,
    conn_id: String,
) -> Result<Value, String>
```
- **PostgreSQL**:
  ```sql
  SELECT c.relname AS name,
         CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname LIKE 'pg_temp%' AND c.relkind IN ('r', 'v', 'm')
  ORDER BY c.relname ASC
  ```
- **MySQL**:
  ```sql
  SELECT NAME AS name, 'table' AS type
  FROM INFORMATION_SCHEMA.INNODB_TEMP_TABLE_INFO
  ```
- **SQLite**:
  ```sql
  SELECT name, type
  FROM sqlite_temp_master
  WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
  ORDER BY name ASC
  ```

---

## 4. Thiết kế Chi tiết Frontend (React / TypeScript)

### 4.1. `src/utils/dbHelper.ts`
- Bổ sung interface `TableProperties`:
  ```typescript
  export interface TableProperties {
    tableName: string;
    schemaName?: string;
    dbType: 'sqlite' | 'postgres' | 'mysql';
    tableType: string;
    engine?: string;
    rowFormat?: string;
    collation?: string;
    characterSet?: string;
    comment?: string;
    tablespace?: string;
    filePath?: string;
    estimatedRows: number;
    exactRows?: number;
    dataSizeBytes?: number | null;
    indexSizeBytes?: number | null;
    totalSizeBytes?: number | null;
    freeSizeBytes?: number | null;
    avgRowLengthBytes?: number | null;
    autoIncrement?: number | null;
    createTime?: string | null;
    updateTime?: string | null;
    checkTime?: string | null;
    columnCount: number;
    primaryKeys: string[];
    indexCount: number;
    foreignKeyCount: number;
    liveTuples?: number | null;
    deadTuples?: number | null;
    lastVacuum?: string | null;
    lastAnalyze?: string | null;
    ddl?: string | null;
  }
  ```
- Bổ sung hàm gọi API:
  - `getTableProperties(connId: string, tableName: string): Promise<{ success: boolean; properties?: TableProperties; error?: string }>`
  - `getTemporaryTables(connId: string): Promise<TableItem[]>`

### 4.2. `src/components/table_properties.css`
Tạo file CSS chuyên biệt với các lớp:
- Layout: `.tp-container`, `.tp-toolbar`, `.tp-content`, `.tp-grid`.
- Card hiển thị: `.tp-card`, `.tp-card-title`, `.tp-card-body`, `.tp-row`, `.tp-label`, `.tp-val`.
- Badge & Highlight: `.tp-badge`, `.tp-metric-pill`, `.tp-metric-val`, `.tp-metric-sub`.
- DDL code block: `.tp-codeblock`, `.tp-code-line`.
- Nút bấm: `.tp-btn`, `.tp-btn-primary`, `.tp-btn-secondary`.

### 4.3. `src/components/TablePropertiesView.tsx`
Component hiển thị nội dung chính khi `viewMode === 'properties'`:
- Header Toolbar: Nút `Refresh`, Nút `Count Exact Rows` (tính toán chính xác bằng `get_exact_table_row_count` khi người dùng yêu cầu), Nút `Copy Summary (Markdown)`, Nút `Copy DDL`.
- Thẻ 1: General & Engine Information (Tên bảng, schema, loại, engine, collation, comment).
- Thẻ 2: Storage & Sizes (Kích thước data, index, free space, dung lượng TB mỗi bản ghi, auto-increment).
- Thẻ 3: Rows & Statistics (Ước lượng số dòng, số dòng chính xác, live/dead tuples, vacuum/analyze).
- Thẻ 4: Columns & Keys Summary (Số cột, badges danh sách PK, số index, số khóa ngoại).
- Thẻ 5: DDL Definition (Toàn văn câu lệnh CREATE TABLE kèm syntax highlighting).

### 4.4. `src/components/DataGrid.tsx`
- Mở rộng kiểu view mode:
  ```typescript
  initialViewMode?: 'data' | 'structure' | 'chart' | 'properties';
  const [viewMode, setViewMode] = useState<'data' | 'structure' | 'chart' | 'properties'>(initialViewMode);
  ```
- Thêm nút chuyển chế độ vào thanh bottom bar:
  ```tsx
  <button
    className={`gp-btn ${viewMode === 'properties' ? 'on' : ''}`}
    onClick={() => setViewMode('properties')}
    title={t('dataGrid.propertiesTab')}
  >
    <Sliders size={12} />
    <span>{t('dataGrid.propertiesTab')}</span>
  </button>
  ```
- Hiển thị `<TablePropertiesView connId={connId} tableName={tableName} dbType={dbType} />` khi `viewMode === 'properties'`.

### 4.5. `src/components/Sidebar.tsx`
- Cập nhật định nghĩa:
  `type ObjectSection = 'tables' | 'views' | 'temporary';`
- Bổ sung state `tempTables: TableItem[]`.
- Trong `fetchTables` và sau khi thực thi câu lệnh SQL: gọi `dbHelper.getTemporaryTables(connId)`.
- Hiển thị mục **Temporary**:
  - Chỉ render khi `filteredTempTables.length > 0`.
  - Icon phân biệt (ví dụ: `Clock` hoặc `Timer`) kèm badge số lượng.
  - Hỗ trợ click mở Data, expand xem chi tiết, và chuột phải menu ngữ cảnh (Open Data, Open Structure, Table Properties, Drop).
- Chuột phải trên bảng/view: Thêm mục menu ngữ cảnh **Properties...** → Kích hoạt `onSelectTable(tableName, 'properties')`.
- Khi disconnect hoặc switch database: Reset `tempTables = []`.

### 4.6. `src/App.tsx`
- Hỗ trợ mở tab bảng với `initialViewMode = 'properties'`.
- Truyền `initialViewMode` xuống `DataGrid`.

---

## 5. Kế hoạch Kiểm thử & Xác minh

### 5.1. Automated Verification
- Kiểm tra type tĩnh TypeScript:
  ```powershell
  npx tsc --noEmit
  ```
- Linter kiểm tra code chất lượng cao:
  ```powershell
  npx oxlint
  ```
- Chạy unit tests:
  ```powershell
  npm test
  ```

### 5.2. Manual Verification
1. **Kiểm tra Tab Properties**:
   - Mở 1 bảng trong cơ sở dữ liệu (SQLite, MySQL, Postgres).
   - Chuyển đổi giữa các tab: `Data` ⇄ `Structure` ⇄ `Chart` ⇄ `Properties`.
   - Xác minh toàn bộ thông số: Dung lượng data, index, free space, engine, collation, DDL hiển thị đầy đủ.
   - Thử bấm nút `Count Exact Rows` trên bảng lớn → Đảm bảo đếm chính xác và không bị lag/freezing giao diện.
   - Thử bấm `Copy DDL` và `Copy Summary` → Kiểm tra clipboard.
   - Chuột phải bảng ở Sidebar → Chọn `Properties...` → Tab bảng mở ra ở chế độ `Properties`.
2. **Kiểm tra Temporary Tables**:
   - Chạy lệnh tạo bảng tạm trong Query Editor:
     - SQLite: `CREATE TEMP TABLE temp_demo (id INT PRIMARY KEY, name TEXT);`
     - Postgres: `CREATE TEMP TABLE temp_demo (id INT, name TEXT);`
     - MySQL: `CREATE TEMPORARY TABLE temp_demo (id INT, name VARCHAR(50));`
   - Quan sát Sidebar: Mục **Temporary** xuất hiện với badge số lượng `(1)`.
   - Click vào `temp_demo`: Tab mở ra xem dữ liệu bình thường.
   - Bấm sang `Structure`: Xem được cấu trúc cột/khóa của bảng tạm.
   - Bấm sang `Properties`: Xem được thuộc tính của bảng tạm.
   - Chạy `DROP TABLE temp_demo;` hoặc Refresh: Mục **Temporary** tự động biến mất hoàn toàn khỏi Sidebar.
   - Ngắt kết nối: Xác minh state bảng tạm được dọn dẹp sạch sẽ.
3. **Kiểm tra Style & UI Rules**:
   - Kiểm tra mã nguồn không có inline styles trái quy định.
   - Các nút bấm tuân thủ viền độc lập `1px solid var(--win-border)`, radius 6px.
   - Kiểm tra hiển thị đa ngôn ngữ trên 3 thứ tiếng: Tiếng Việt, Tiếng Anh, Tiếng Nhật.
