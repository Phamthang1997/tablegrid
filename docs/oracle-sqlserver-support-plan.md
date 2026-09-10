# Kế hoạch: hỗ trợ Oracle Database và Microsoft SQL Server

> Trạng thái: **đề xuất** — chưa viết dòng code nào.
> Phạm vi: thêm hai dialect SQL vào `DbKind`, nâng từ 3 lên 5 engine.
> Tài liệu liên quan: `docs/backend-module-split-plan.md` (bản đồ module),
> `docs/postgres-schema-support-plan.md` §4.2 (danh sách call site build SQL từ tên bảng),
> `docs/multi-connection-plan.md` §4 (registry, `ConnId`).

---

## 0. Kết luận trước, lý lẽ sau

1. **SQL Server làm trước, Oracle làm sau** — nhưng vì lý do *độ chín của driver*, không vì lý do kiến trúc. SQL Server có `tiberius`: Rust thuần, async, không phụ thuộc native. Oracle có **hai** đường, và chúng khác nhau về mọi mặt (§4.1): `oracle` (rust-oracle) bọc ODPI-C — chín, nhưng **blocking** và cần Instant Client lúc runtime; `oracle-rs` là Rust thuần async không cần client — khớp kiến trúc app **tốt hơn cả `tiberius`**, nhưng ở 0.1.7 và im lặng 5,5 tháng. Chọn đường nào là kết quả của một spike 2–3 ngày, không phải của suy luận.
2. **Không thêm hai arm vào 62 chỗ `match DbKind` và 168 chỗ so sánh chuỗi `db_type`.** Trước khi thêm engine, phải có **một seam dialect** (§2). Nếu bỏ qua bước này, mỗi tính năng sau đó phải sửa 5 nhánh thay vì 1, và `_ =>` catch-all hiện có sẽ **âm thầm** trả lời sai thay vì không compile — `qualified()` trong `database/ident.rs:38` là ví dụ sống: Oracle/MSSQL rơi vào `_ =>` và mất schema qualification, không có lỗi nào.
3. **Ship theo tier, không ship theo "xong hết".** 148 command hiện có; một engine mới không cần cả 148 để hữu ích. Tier 1 (đọc) đã là một DB browser dùng được.
4. **Hai quyết định thiết kế phải chốt trước khi code**, vì chúng đổi cả frontend: Oracle không có khái niệm "database" như MySQL (§4.2), và SQL Server cần **đồng thời** cả database picker lẫn schema picker — mà schema picker hiện tại là Postgres-only theo thiết kế (§4.2).
5. **Instant Client không bao giờ đính vào source.** Nó không vào git ở bất kỳ lựa chọn nào — câu hỏi là nó nằm ở đâu lúc *phân phối*, và câu đó **chỉ tồn tại nếu chọn `rust-oracle`**. Chọn `oracle-rs` thì cả cụm vấn đề Instant Client / OTN / AGPL / blocking pool biến mất cùng lúc (§4.1.2). Đó là lý do spike ở phase 0 đáng làm trước mọi thứ khác của Oracle.

---

## 1. Khảo sát bề mặt hiện tại (số đo, không phải cảm giác)

| Bề mặt | Số lượng | Nguồn |
|---|---|---|
| `match`/`matches!` trên `DbKind` (Rust) | **62 chỗ / 30 tệp** | `grep -rc "DbKind::Mysql"` |
| So sánh chuỗi `"mysql"`/`"postgres"`/`"sqlite"` (Rust) | **168** | grep |
| So sánh chuỗi dialect (frontend `src/`) | **513** trên 48 tệp | grep |
| `#[tauri::command]` đã đăng ký | **~148** | `app/handlers.rs` |
| Chỗ build `LIMIT`/`OFFSET` | 50 (Rust) + 100 (FE) | grep |
| Thân hàm dựng row theo driver | 3 funnel × 3 dialect = **9** | `exec/{raw,bound,stream}.rs` |

Bản đồ hàm cần một nhánh mới, theo tệp (đã dò bằng grep, không suy đoán):

- `database/ident.rs` — `quote_ident`, `qualified`, `fk_checks_sql`
- `database/introspect.rs` — `get_tables_inner`, `get_table_schema_inner`, `get_primary_key_columns`, `get_temporary_tables_inner`, `list_databases_inner`
- `database/exec/{raw,bound,stream}.rs` — ba funnel
- `database/decode.rs` — hai macro decode (sẽ thành bốn)
- `database/dsn.rs` — `build_*_url`
- `database/commands/` — `connection.rs` (`connect_db`), `catalog.rs` (`get_tables`), `databases.rs` (5 lệnh), `table_ddl.rs` (`create_table`, `get_table_definition`, `rename_table`, `truncate_table`), `table_alter.rs` (`alter_table_schema`, `preview_alter_schema`), `row_read.rs` (`get_table_data`), `row_write.rs` (`commit_changes`, `bulk_insert`, `import_new_table`), `restore.rs`, `status.rs`, `ddl_extras.rs`, `objects/{listing,triggers,sequences,partitions,constraints}.rs`
- `stats/` — `table_properties.rs`, `sizes.rs`, `row_count.rs`, `database.rs`, `all_databases.rs`
- `tx/` — `effect.rs` (`dialect_of`), `route.rs` (`should_route`)
- `compare/side.rs` + `compare/read/` (cần thêm `oracle.rs`, `mssql.rs`)
- `datagen/` — `ident.rs`, `column.rs` (`Cell::Raw` theo dialect)
- `database/iam.rs` — `build_iam_conn`

---

## 2. Bước tiên quyết: seam dialect (Phase 1, refactor thuần, không thêm engine)

Mục tiêu: sau phase này **không có engine mới nào**, 130 test Rust vẫn xanh, hành vi byte-identical — nhưng thêm engine thứ tư chỉ còn là thêm **một** tệp thay vì sửa 62 chỗ.

### 2.1. `database/dialect.rs` — bảng capability dạng dữ liệu

Phần lớn 62 nhánh không phải logic, chỉ là **một hằng khác nhau**. Gom chúng vào một struct hằng, tra cứu bằng `DbKind`:

```rust
pub struct Dialect {
    pub name: &'static str,               // "oracle" — thay dialect_of()
    pub quote_open: char,
    pub quote_close: char,                // " " | ` ` | [ ]
    pub qualifies_with_schema: bool,      // PG, MSSQL, Oracle = true; MySQL/SQLite = false
    pub default_schema: Option<&'static str>, // "public" | "dbo" | None
    pub has_databases: bool,              // Oracle = false (§4.2)
    pub ddl_implicitly_commits: bool,     // MySQL, Oracle = true
    pub paging: Paging,                   // LimitOffset | FetchFirst (bắt buộc ORDER BY)
    pub savepoint_kw: &'static str,       // "SAVEPOINT" | "SAVE TRANSACTION"
    pub begin_stmt: Option<&'static str>, // None cho Oracle (không có BEGIN)
    pub terminator: Terminator,           // Semicolon | SemicolonOrSlash (Oracle)
    pub isolation_levels: &'static [&'static str],
    pub folds_unquoted_to_upper: bool,    // Oracle = true (§4.3)
    pub supports_iam: bool,               // RDS IAM chỉ PG/MySQL → false cho cả hai engine mới
}
```

Điều này xoá được nhóm lớn nhất trong 62 nhánh mà **không** cần trait object hay dyn dispatch.

### 2.2. `trait DialectSql` — cho phần thật sự là SQL introspection

Những gì không gói được vào hằng (câu truy vấn catalog, dựng DDL) đi qua trait, một impl một tệp: `database/dialects/{postgres,mysql,sqlite}.rs` (rồi `mssql.rs`, `oracle.rs`).

```rust
pub trait DialectSql {
    fn list_tables_sql(&self, schema: &str) -> String;
    fn table_columns_sql(&self, schema: &str, table: &str) -> String;
    fn primary_key_sql(&self, schema: &str, table: &str) -> String;
    fn list_databases_sql(&self) -> Option<String>;
    fn temp_tables_sql(&self) -> Option<String>;
    fn page_clause(&self, limit: u64, offset: u64, has_order_by: bool) -> Result<String, String>;
    fn fk_checks_sql(&self, tables: &[String], on: bool) -> Vec<String>;
    // …
}
```

**Ràng buộc**: mọi hàm ở đây trả về `String` SQL, **không** chạm driver. Nhờ vậy chúng là hàm thuần và test được bằng `cargo test --lib` mà không cần một Oracle nào — cùng lý lẽ đã đặt `splitter.rs`, `ident.rs`, `datagen/rng.rs` thành hàm thuần.

### 2.3. Ba việc phải xử lý riêng, seam không giải quyết được

1. **`_ =>` catch-all là nợ, không phải tiện lợi.** Trước khi thêm arm, đổi mọi `match &conn.kind { … _ => … }` liên quan dialect thành match đủ arm, để compiler chỉ ra 62 chỗ thay vì để chúng rơi vào nhánh Postgres. Đây là việc đầu tiên của phase 1 và là thứ duy nhất khiến phase 2/3 an toàn.

2. **`decode_*_cell!` không seam được.** `tiberius::Row` và `oracle::Row` không implement `sqlx::Row`; macro hiện tại dựa vào `sqlx::Row::try_get`. Sẽ có **4 macro** decode. Hai luật ở CLAUDE.md (`uniquify_columns` trước khi dựng row; decode **theo index**, không theo tên) phải lặp lại ở mỗi macro và mỗi funnel → 3 funnel × 5 dialect = **15 thân hàm dựng row**. Đây là chi phí cơ học lớn nhất của toàn bộ kế hoạch và không có cách nào tránh, chỉ có cách làm cho nó dễ soát: mỗi funnel một tệp, cùng thứ tự hàm, và một test "SELECT * có tên cột trùng" cho **mỗi** dialect.

3. **`LIMIT`/`OFFSET`.** Oracle 12c+ và SQL Server 2012+ dùng `OFFSET n ROWS FETCH NEXT m ROWS ONLY`, và **cả hai bắt buộc có `ORDER BY`**. `get_table_data` hiện chỉ thêm `ORDER BY <pk>` ở edit mode (`row_read.rs:92`); ở read mode nó phân trang không có order — đã là bug im lặng trên PG/MySQL, sẽ là **lỗi cú pháp** trên hai engine mới. `page_clause(..., has_order_by)` phải trả `Err` khi thiếu order trên dialect `FetchFirst`, để bug lộ ra ở call site chứ không lộ ra ở mặt người dùng.

4. **`fk_checks_sql` phải đổi chữ ký ở phase 1, không phải phase 2.** Nó trả `-> &'static str` chỉ vì cả 3 dialect hiện tại có đúng một câu session-level. SQL Server **không có** công tắc session — chỉ có `ALTER TABLE … NOCHECK CONSTRAINT ALL` theo từng bảng. Phát hiện việc đó ở phase 1 (khi đổi kiểu là refactor 3 call site) rẻ hơn nhiều so với ở giữa phase 2.

**Chi phí phase 1**: ~5–8 ngày. Không có tính năng mới. Đây là phần khó bán nhất và là phần quyết định hai phase sau tốn 3 tuần hay 3 tháng.

---

## 3. Phase 2 — Microsoft SQL Server

### 3.1. Driver

- **`tiberius`** (TDS thuần Rust, async). `sqlx` **đã bỏ** MSSQL từ 0.7 nên không có đường đi qua sqlx.
- Không có pool sẵn → `deadpool-tiberius` hoặc `bb8-tiberius`. `DbKind::Mssql(Pool)` giữ được đúng khuôn "clone handle ra, drop lock trước mọi `.await`".
- **TLS: bật feature `rustls`, không dùng default `native-tls`.** App đã ship rustls hai lần (`sqlx` `tls-rustls`, `redis` `tokio-rustls-comp`); thêm native-tls là thêm một stack TLS thứ hai vào binary và một phụ thuộc OpenSSL/schannel vào build.
- `tiberius` nhận `AsyncRead + AsyncWrite` của futures-io, không của tokio → thêm `tokio-util = { features = ["compat"] }`.
- **Windows Authentication** là auth method người dùng SQL Server mong đợi nhất, nhưng là feature riêng (`integrated-auth-gssapi` trên Unix, SSPI trên Windows) và cần gssapi trên CI Linux. Đề xuất: **Tier 2**, MVP chỉ SQL auth.
- **Named instance** (`HOST\SQLEXPRESS`) cần tra cổng qua SQL Browser UDP 1434 (`tiberius::SqlBrowser`). Không có nó thì `localhost\SQLEXPRESS` không kết nối được — mà đó là cấu hình dev phổ biến nhất. Xếp vào **MVP**, không Tier 2.

### 3.2. Khác biệt ngữ nghĩa phải xử lý

| Chủ đề | SQL Server | Chỗ phải sửa |
|---|---|---|
| Quote identifier | `[name]`, escape `]` → `]]` | `quote_ident` |
| Database **và** schema | có cả hai (`db.dbo.tbl`) | §4.2 — thay đổi frontend |
| Paging | `OFFSET/FETCH`, cần `ORDER BY` | `page_clause`, `row_read.rs` |
| `TOP n` | thay `LIMIT n` khi không cần offset | các chỗ `LIMIT 1` / `LIMIT 100` |
| Transaction | `BEGIN TRANSACTION`; `SAVE TRANSACTION x` (không `SAVEPOINT`); `SET TRANSACTION ISOLATION LEVEL` phải **trước** BEGIN | `tx/session.rs`, `tx/effect.rs`, `TxControl.tsx` |
| Isolation | thêm `SNAPSHOT` | UI isolation select |
| Catalog | `sys.tables`/`sys.columns` + `INFORMATION_SCHEMA` | `dialects/mssql.rs` |
| Temp table | `tempdb.sys.tables`, tên `#tmp` | `get_temporary_tables_inner` |
| Rename | `sp_rename` | `rename_table` |
| DDL text | **không** có `SHOW CREATE TABLE` → dựng tay như Postgres | `get_table_definition` |
| Batch separator | `GO` là lệnh **client-side** (như MySQL `DELIMITER`) | `splitter.rs` **và** `src/sql/statements.ts` — cặp hand-synced |
| Multi-row INSERT | có, nhưng giới hạn **1000 row** và **2100 parameter** | `dumpBuilder.ts` (đang batch 500 → OK), `bulk_insert` |
| Identity | `IDENTITY(1,1)`; `SET IDENTITY_INSERT t ON` khi restore | `restore.rs`, `dumpBuilder.ts` |
| FK off | `ALTER TABLE … NOCHECK CONSTRAINT ALL`, **per-table** | `fk_checks_sql` → `Vec<String>` (§2.3.4) |
| Bool | không có `BOOLEAN`, dùng `BIT` | `decode_mssql_cell!`, `datagen/column.rs`, `inspection.ts` type family |
| EXPLAIN | `SET SHOWPLAN_XML ON`, một câu riêng, output XML | `src/utils/explainHelper.ts` |
| Process monitor | `sys.dm_exec_requests` + `sys.dm_exec_sql_text` | `database/commands/process.rs` |

### 3.3. Test

`mcr.microsoft.com/mssql/server:2022-latest` (Developer edition, miễn phí) chạy docker được → integration test khả thi, kể cả trên CI. Đề xuất: một docker-compose ở `tests/` + test đánh dấu `#[ignore]`, để `cargo test --lib` mặc định vẫn không cần network (giữ nguyên hợp đồng hiện tại của 130 test).

**Chi phí phase 2**: ~15–20 ngày cho Tier 1+2 (§5).

---

## 4. Phase 3 — Oracle

### 4.1. Vấn đề lớn nhất: chọn driver — và hai đường không giống nhau ở bất cứ điểm nào

Oracle có **hai** driver Rust, và lựa chọn giữa chúng quyết định luôn cả kiến trúc, kích thước installer và câu hỏi license. Không phải chọn giữa hai thư viện tương đương.

Nếu quen thuật ngữ của `python-oracledb`/`node-oracledb`: `oracle` (rust-oracle) tương ứng **thick mode**, `oracle-rs` tương ứng **thin mode**. Một khác biệt so với hai thư viện kia: chúng có *cả hai mode trong một thư viện* và mặc định thin; ở Rust đây là **hai crate riêng**, không có công tắc — chọn crate là chọn mode, và đổi ý về sau là đổi driver.

#### 4.1.1. Bảng so sánh

| | `oracle` (rust-oracle) 0.6.3 — *thick* | `oracle-rs` 0.1.7 — *thin* |
|---|---|---|
| Cách hoạt động | Bọc ODPI-C (vendor source C, `cc` biên dịch tĩnh) | **Rust thuần**, tự dựng lại giao thức TNS/TTC (24.341 dòng) |
| Phụ thuộc runtime | **Cần Oracle Instant Client** trên máy người dùng | **Không cần gì** |
| API | **Blocking** | **Async, trên Tokio** |
| Pool | `r2d2-oracle`, hoặc `deadpool` + `spawn_blocking` | `deadpool-oracle` (cùng tác giả) |
| TLS | Của Instant Client | **rustls 0.23** — đúng stack app đang có |
| License | ODPI-C là Apache-2.0/UPL, nhưng `libclntsh` là **OTN proprietary** | **MIT OR Apache-2.0** |
| Oracle tối thiểu | 11.2+ | **12.1+** |
| Tuổi / độ chín | Nhiều năm, dùng rộng | **0.1.7**, tạo 2025-12-15, commit cuối **2026-03-23** |
| Bảo trì | Cộng đồng | **Một người**; 26 star / 17 fork / 13 issue mở |

#### 4.1.2. Nếu `oracle-rs` chạy được, nó xoá gần hết phần khó của phase 3

Không phải giảm, mà là **biến mất**:

- **Instant Client** → không còn: không phình installer, không script tải lúc build, không `bundle.resources`, không cần dò `oci.dll` trước khi connect.
- **OTN redistribute × AGPL** → không còn. Repo là AGPL-3.0-or-later (`src-tauri/Cargo.toml:5`); MIT/Apache-2.0 tương thích, và việc tự phân phối một binary độc quyền dynamic-link tới tác phẩm AGPL không phát sinh nữa. Không phải hỏi pháp lý câu nào.
- **Blocking** → không còn: không `spawn_blocking`, không pool blocking, không lo `oracle::Connection` là `Send` mà không `Sync`. Oracle có **hình dạng y hệt** Postgres/MySQL: `DbKind::Oracle(Pool)`, khớp nguyên khuôn "clone handle ra, drop lock trước mọi `.await`" và `Exec::acquire`.
- **TLS stack thứ hai** → không còn: nó dùng rustls 0.23, và `rustls 0.23.43` đã có trong `Cargo.lock`.

Cây phụ thuộc gần như miễn phí: `hmac 0.12.1`, `sha2 0.10.9`, `thiserror 1.0.69`, `rustls 0.23.43`, `chrono 0.4` **đã nằm trong `Cargo.lock`** (dependency gián tiếp) — cùng lý lẽ đã chọn `base64` và `aes-gcm`. Chỉ `rand 0.8` là mới (app đang có `rand 0.10.2`).

Type coverage đủ cho một DB browser: NUMBER, VARCHAR2/CHAR, DATE, TIMESTAMP (+ WITH TIME ZONE), INTERVAL DAY TO SECOND, RAW, CLOB/NCLOB, BLOB, BOOLEAN, JSON, VECTOR, ROWID, BINARY_FLOAT/DOUBLE. Danh sách "not yet implemented" của nó là AQ, CQN, Sharding, XA, SODA, Application Continuity, Associative Arrays — **app này không dùng cái nào**. Chỉ hai thứ đáng ghi vào release note vì chúng là *giá trị ô*, tức là một cột như thế sẽ không decode được: **XMLType** và **LONG / LONG RAW**.

Mốc "12.1+" của nó **khớp sẵn** với sàn 12c+ mà §4.4 đã đề xuất cho `OFFSET/FETCH`, nên nó không thu hẹp thêm phạm vi nào. Ngược lại `rust-oracle` đỡ tới 11.2 — nếu bắt buộc phải đỡ 11g thì lựa chọn đã bị quyết sẵn, và §4.4 phải thêm nhánh `ROWNUM` lồng.

#### 4.1.3. Vì sao vẫn chưa chọn được nó ngay

Rủi ro không nằm ở năng lực, nằm ở bảo trì. Hôm nay (2026-09-07) nó đã **im 5,5 tháng**, và 12k download thì 11k dồn vào một version — traffic CI, không phải người dùng.

Chi tiết nói nhiều nhất không nằm trong bảng mà nằm ở **nội dung mấy commit cuối**:

```
2026-03-23  Fix OSON decoder container offset size and JSON column row parsing
2026-03-23  Consume LOB locator after JSON column data to fix row parsing
2026-03-23  Consolidate Oracle binary float helpers and fix OSON shared nodes
```

Nó dừng **giữa lúc còn đang sửa lỗi parse row**, không phải dừng sau khi ổn định. Với một DB client, lỗi giao thức nghĩa là **giá trị ô sai một cách im lặng** — đúng lớp lỗi tệ nhất cho app này, và đã có tiền lệ ghi trong CLAUDE.md: MySQL GEOMETRY (`sakila.address.location`) rơi vào `Value::Null`, export ra NULL, chỉ lộ khi import lại thì chết vì NOT NULL. Chọn `oracle-rs` là chấp nhận app này thành một trong những người dùng nghiêm túc đầu tiên của nó.

**Nhưng rủi ro này khác hẳn rủi ro OTN, và khác theo hướng tốt hơn**: MIT/Apache-2.0 + không phụ thuộc thư viện Oracle nào = **fork được**. 24k dòng Rust là thứ tự nuôi được khi cần. Đường Instant Client không bao giờ có lựa chọn đó — giao thức độc quyền thì không tự sửa. Nên đây là rủi ro "có thể phải tự bảo trì", không phải rủi ro "bị chặn".

#### 4.1.4. Điều kiện nghiệm thu của spike (phase 0, 2–3 ngày)

Câu hỏi của spike **không** phải "nó compile được không", mà: **`oracle-rs` có đọc đúng một schema thật không?** Chạy với `container-registry.oracle.com/database/free`:

1. Mỗi type trong bảng coverage của nó, gồm NULL và giá trị biên (NUMBER precision lớn, TIMESTAMP WITH TIME ZONE, INTERVAL).
2. **`SELECT *` join rộng có tên cột trùng** — hai luật của app (`uniquify_columns` trước khi dựng row, decode **theo index**) phải giữ được; đây là chỗ một driver mới dễ sai nhất.
3. CLOB/BLOB, cả đường auto-fetch và đường streaming.
4. Một schema **thật** (HR sample hoặc schema nội bộ), không phải bảng tự tạo cho test.
5. `deadpool-oracle` mở nhiều connection song song, và một connection sống qua nhiều statement (điều `Exec` cần cho transaction).

Hai nhánh kết quả, cả hai đều tốt hơn hiện trạng:

- **Đạt** → Oracle **rẻ hơn SQL Server** về khớp kiến trúc. `tiberius` mới là cái cần `tokio-util::compat` và một pool bên ngoài; `oracle-rs` vừa khít khuôn có sẵn. Thứ tự phase 2 / phase 3 vẫn giữ (SQL Server trước) vì độ chín, nhưng chi phí phase 3 giảm.
- **Không đạt** → quay về `rust-oracle`, và khi đó §4.1.5 áp dụng. Mất 3 ngày, đổi lại biết chính xác nó hỏng ở đâu.

#### 4.1.5. Plan B: nếu phải dùng `rust-oracle` (thick mode)

Giữ nguyên mục này trong doc dù đề xuất là `oracle-rs` — không phải vì cần cả hai, mà vì nếu spike hỏng thì không phải nghĩ lại từ đầu.

**Native.** ODPI-C được biên dịch tĩnh từ source C bởi `cc` → *build* không cần Oracle gì, **CI compile bình thường**; binary **không có** import table entry cho `oci.dll`. ODPI-C `LoadLibrary`/`dlopen` **lúc connect đầu tiên**. Nghĩa là thiếu Instant Client không làm build fail, không làm app fail lúc mở — **chỉ fail khi người dùng bấm Connect**. Đây là câu hỏi *phân phối*, không phải *build*.

**Instant Client sống ở đâu — ba lựa chọn.** Không lựa chọn nào commit binary vào git; với (b) thứ được commit là *script tải*, thư mục tải về vào `.gitignore`.

| | Ở đâu | Kích thước installer | Vấn đề |
|---|---|---|---|
| **(a)** | Người dùng tự cài, để trên `PATH` | +0 | Cần trang hướng dẫn + **dò thư viện trước khi thử connect** để báo lỗi tử tế thay vì để ODPI-C crash |
| **(b)** | Tải lúc build (script CI) → `bundle.resources`, giải nén cạnh exe | **+110MB** | Phình × 3 nền tảng; macOS phải codesign từng dylib; **và là lựa chọn duy nhất phát sinh câu hỏi license** |
| **(c)** | Tải lần đầu người dùng dùng Oracle, vào appdata | +0 với người không dùng Oracle | Cần mạng; phải kiểm URL tải của Oracle còn không đòi login |

Với (b)/(c), app phải chỉ đường cho ODPI-C: `oracle::init_oracle_client` với `oracleClientLibDir`, hoặc `AddDllDirectory` trên Windows trước lần connect đầu.

**Con số 35MB là bẫy.** Basic Light (~35MB) chỉ đỡ một tập charset hẹp (US7ASCII, WE8MSWIN1252, UTF8, AL16UTF16, AL32UTF8...); DB dùng national charset khác **không kết nối được**. Muốn chắc phải là **Basic ~110MB**. Nếu chọn (b), con số đưa vào quyết định là 110MB.

**AGPL.** Chỉ (b) mới đặt ra vấn đề: ta tự phân phối một binary độc quyền trong cùng installer với một tác phẩm AGPL mà ta dynamic-link tới, và Instant Client **không phải "System Library"** theo nghĩa GPL. Không phải kết luận pháp lý, nhưng đủ rõ để nói: **chọn (b) thì phải hỏi pháp lý hai câu** — OTN cho redistribute không, *và* AGPL của repo chịu được không. (a) và (c) là cấu hình chuẩn mà DBeaver thick mode, python-oracledb thick mode, godror đều dùng: người dùng tự cung cấp client.

**Blocking.** Mọi `.await` thành `tokio::task::spawn_blocking`. Hình dạng giống `DbKind::Sqlite(Arc<Mutex<Connection>>)` nhưng **hệ quả khác**: SQLite là một handle dùng chung nên "một session" là miễn phí (`tx/` khai thác đúng điều đó); Oracle là server thật, cần nhiều connection song song → pool blocking (`r2d2-oracle`, hoặc `deadpool` + `spawn_blocking`), và số connection trong pool thành số blocking thread bị giữ. `spawn_blocking` không phá luật `Box::pin`, nhưng thêm ràng buộc: closure phải `'static + Send`, handle phải `move` vào, giá trị trả về phải `Send` — `oracle::Connection` là `Send` nhưng **không** `Sync`.

**Trong ba lựa chọn thì đề xuất là (a)**: sạch nhất trên cả ba mặt, và chi phí là code (~1–2 ngày dò thư viện + thông báo lỗi + trang hướng dẫn) chứ không phải thời gian chờ pháp lý.

### 4.2. Vấn đề lớn thứ hai: Oracle không có "database", SQL Server có cả hai

App hiện coi "database" là một slot bắt buộc: `open_database`, `list_databases`, `create_database`, `drop_database`, `rename_database`, `get_all_databases_stats`, `DbRail`, và **`scopeKey(config, db, schema)`** dùng nó để key tab list + draft SQL trong localStorage.

Ở Oracle, cái tương ứng với "một namespace chứa bảng" là **schema (= user)**; "database" là instance/PDB. Hai cách map:

- **(A) Oracle schema → slot "database" của app.** `list_databases` trả `ALL_USERS` (lọc schema hệ thống), `open_database('HR')` = `ALTER SESSION SET CURRENT_SCHEMA = HR`. Không đổi frontend, `scopeKey` vẫn đúng. Đổi lại: `create/drop/rename database` phải bị **ẩn** (`has_databases: false`), không phải trả lỗi; và từ "database" trong UI mang nghĩa khác với nghĩa Oracle mà người dùng Oracle biết.
- **(B) Oracle schema → slot "schema" (dùng cơ chế Postgres schema đã có), "database" → PDB.** Đúng ngữ nghĩa hơn, nhưng chuyển PDB cần `ALTER SESSION SET CONTAINER` và quyền hệ thống mà DBA không cấp cho user thường → phần lớn người dùng sẽ thấy một database picker chỉ có một mục.

**Đề xuất (A)**: không đòi quyền đặc biệt, không đổi frontend. Ghi rõ trong tooltip.

Ngược lại, **SQL Server có cả database lẫn schema và cần cả hai** — đây là thay đổi frontend thật:
- `list_schemas` hiện `return []` cho non-Postgres → đó là cách UI quyết định có hiện schema picker hay không.
- `qualified()` chỉ qualify khi `DbKind::Postgres`.
- `scopeKey` chỉ thêm `:schema` khi schema != `public` (để mọi key tiền-schema giữ nguyên chính tả — luật này **phải giữ**).
- `ConnEntry.current_schema` đã là per-connection → **phần khó nhất đã xong**. Chỉ cần đổi điều kiện từ "là Postgres" thành `dialect.qualifies_with_schema`, và đổi default `public` thành `dialect.default_schema` (`dbo` cho MSSQL, user hiện tại cho Oracle).
- `pg_schema_of` cứng hoá `"public"` ở **đúng một chỗ** (chủ ý thiết kế). Chỗ đó thành `dialect.default_schema`; mọi test hiện có phải cho ra **cùng kết quả** với Postgres.

### 4.3. Vấn đề lớn thứ ba: case folding identifier

Oracle fold identifier không-quote thành **UPPERCASE**; app này **quote mọi thứ**. Hệ quả cụ thể:

- Bảng tạo ngoài app tên `EMPLOYEES`; catalog trả `EMPLOYEES`; app quote `"EMPLOYEES"` → **đúng**.
- `CreateTableModal` với người dùng gõ `employees` → app tạo `"employees"` (chữ thường, tồn tại được nhưng phải quote mãi mãi) → **đúng kỹ thuật, sai kỳ vọng**: mọi tool Oracle khác sẽ tạo `EMPLOYEES`.
- Search/filter Sidebar, `stmt_mentions_table` của restore, `TableMatcher`, `compare/` so tên bảng, `inspection.ts` tra catalog: tất cả so **case-sensitive**.

**Đề xuất**: `dialect.folds_unquoted_to_upper` + một hàm `normalize_new_ident()` chỉ áp dụng ở **đường tạo mới** (create table/column/index), upper-case tên người dùng gõ khi nó all-lowercase và không có ký tự đặc biệt. Đường **đọc** giữ verbatim từ catalog. Tuyệt đối không fold ở đường đọc — đó là cách làm mất một bảng thật tên chữ thường.

### 4.4. Các khác biệt còn lại

| Chủ đề | Oracle | Chỗ phải sửa |
|---|---|---|
| Paging | `OFFSET … FETCH NEXT` (12c+), cần `ORDER BY`; 11g phải `ROWNUM` lồng | `page_clause` — đề xuất **chỉ đỡ 12c+**, báo rõ ở connect |
| `BOOLEAN` | không có trước 23ai → `NUMBER(1)` | decode, datagen, `inspection.ts` |
| `DUAL` | `SELECT 1 FROM DUAL` | mọi câu probe/ping (`status.rs`) |
| Multi-row INSERT | **không có** `VALUES (…),(…)` → `INSERT ALL INTO t VALUES … SELECT * FROM DUAL` | `dumpBuilder.ts` `buildSql()`, `bulk_insert` |
| Auto increment | identity (12c+) hoặc sequence + trigger | `table_ddl.rs`; tương đương `setval` là `ALTER SEQUENCE … RESTART START WITH` |
| Terminator | `;` cho SQL, **`/`** cho khối PL/SQL | `splitter.rs` + `src/sql/statements.ts` — cặp hand-synced, sửa cùng nhau |
| DDL implicit commit | có (như MySQL) | `tx/effect.rs` đã mô hình hoá, chỉ thêm dialect |
| `BEGIN` | **không có** lệnh BEGIN; transaction mở ngầm ở DML đầu tiên | `tx/route.rs` `should_route`, `dialect.begin_stmt = None`; `TxControl` không được hứa "BEGIN đã chạy" |
| Savepoint | `SAVEPOINT x` (giống PG) | — |
| Isolation | chỉ `READ COMMITTED` + `SERIALIZABLE` | isolation select phải theo dialect |
| DDL text | `DBMS_METADATA.GET_DDL('TABLE', name, schema)` | `get_table_definition` — có sẵn, tốt hơn PG |
| Catalog | `ALL_TABLES` / `ALL_TAB_COLUMNS` / `ALL_CONSTRAINTS` (dùng `ALL_*` không `USER_*`, để thấy schema khác) | `dialects/oracle.rs` |
| Temp table | `ALL_TABLES.TEMPORARY = 'Y'` — **global** temp table, không per-session như PG/MySQL | `get_temporary_tables_inner`; ngữ nghĩa khác, phải ghi rõ trong UI |
| Stats/size | `DBA_SEGMENTS` (cần quyền) / `USER_SEGMENTS` | `stats/sizes.rs` — `.ok()`-dung thứ như `table_properties.rs` đã làm |
| EXPLAIN | `EXPLAIN PLAN FOR …` rồi `SELECT … FROM TABLE(DBMS_XPLAN.DISPLAY)` — **hai câu** | `explainHelper.ts` |
| LOB | CLOB/BLOB đọc qua API streaming riêng | `decode_oracle_cell!` |
| IAM | RDS IAM **không** hỗ trợ Oracle/SQL Server | `dialect.supports_iam = false`, ẩn tab AWS IAM |
| Test | `container-registry.oracle.com/database/free:latest` (Oracle Database Free 23ai) chạy docker được | integration test khả thi |

**Chi phí phase 3**: ~20–30 ngày cho Tier 1+2 — nhưng con số này phụ thuộc driver nào thắng ở spike:

- **`oracle-rs`**: đầu thấp của khoảng, ~20–24 ngày. Không có việc đóng gói, không chờ pháp lý, và pool/async khớp khuôn có sẵn nên không phát sinh tầng `spawn_blocking` nào.
- **`rust-oracle`**: đầu cao, ~26–30 ngày, cộng ~1–2 ngày cho việc dò thư viện + thông báo lỗi + trang hướng dẫn nếu chọn (a). Nếu chọn (b) thì cộng cả thời gian chờ pháp lý — thời gian không lập trình được (§4.1.5).

---

## 5. Tier tính năng (thứ tự ship)

Không engine nào cần cả 148 command để hữu ích. Mỗi tier là một PR bán được.

**Tier 1 — đọc (MVP).** Connect/disconnect, list databases + schemas + tables + views, `get_table_schema`, `get_table_data` có phân trang, chạy SQL trong SQL Editor (kể cả multi-statement), export dump, `StructureViewer` read-only, `get_table_definition`.

Bắt buộc kèm theo, không được để sau:
- `read_only.rs` hoạt động trên dialect mới (`reject_if_read_only` nằm trong funnel nên tự có, nhưng phải test).
- `safeMode.ts` `COMMAND_KINDS` phân loại xong — `safeMode.test.ts` đọc `dbHelper.ts` và **fail** nếu có command chưa phân loại.
- `backendErrors.ts` có entry cho mọi literal Việt mới — `backendErrors.test.ts` yêu cầu round-trip byte-identical.

**Tier 2 — ghi.** `commit_changes` (grid Save — cần `get_primary_key_columns` đúng), `create_table` / `alter_table_schema` / `preview_alter_schema`, `drop_table` / `truncate_table` / `rename_table`, `tx/` (manual transaction). Đây là tier nhiều bẫy nhất: `commit_changes` phải hỏi `use_session()` chứ không `is_open()`, và mọi funnel mới **phải** gọi `should_route()` — bỏ một chỗ nghĩa là grid refresh đọc qua connection khác và người dùng thấy "mất dữ liệu".

**Tier 3 — object phụ.** Triggers, routines, sequences, view editor, partitions, check constraints, `get_table_properties`, process monitor, `get_database_objects`.

**Tier 4 — tính năng lớn.** `restore_backup`, `compare/` (thêm `compare/read/{oracle,mssql}.rs`), `datagen/`, ER diagram, schema migration.

**Không làm** (ghi rõ để không ai đi tìm): tính năng Redis-only; AWS IAM (§4.4); MCP write access chỉ mở sau khi Tier 2 ổn định.

---

## 6. Frontend

- `DbConnectionConfig.type` từ union 4 giá trị thành 6. Vì nó là union literal, `tsc -b` sẽ chỉ ra **mọi** `switch`/so sánh thiếu nhánh — dùng đúng cơ chế đó: **đừng thêm `default:` mới** trong lúc port.
- `ConnectionManager.tsx`: thêm 2 form. MSSQL cần `instanceName`, `encrypt`, `trustServerCertificate`, `authMethod: 'sql' | 'windows'`. Oracle cần chọn **service name vs SID vs TNS alias** — ba thứ này không thay thế nhau và người dùng Oracle mong có cả ba.
- `sql/format.ts`: `sql-formatter` **đã có** `plsql` và `transactsql` (đã kiểm `supportedDialects`) → chỉ thêm 2 dòng vào `formatterDialect()`.
- `sql/sqlLanguage.ts`: **`monaco-sql-languages` KHÔNG có parser Oracle hay T-SQL.** Nó chỉ có flink / hive / impala / mysql / pgsql / spark / trino / generic (đã kiểm `esm/languages/` và `LanguageIdEnum`). Hai engine mới phải dùng `genericsql`, tức là **đúng đường mà SQLite đang đi**. Hệ quả: completion từ catalog (tables/columns/FK JOIN) vẫn chạy vì app tự dựng; nhưng keyword completion theo dialect, ANTLR entities và alias scope rơi vào **đường degraded đã được mô tả trong CLAUDE.md** (merge với `collectTableRefs()`, suy luận table-vs-column từ text). Đây là giới hạn phải nói trong release note, không phải bug cần sửa — nâng cấp thật cần một grammar mới trong `monaco-sql-languages`, ngoài phạm vi.
- `inspection.ts`: mỗi check phụ thuộc dialect phải **không làm gì** khi dialect lạ, theo đúng luật "im lặng hơn cảnh báo sai" đã có. Đừng để check ambiguity của MySQL/PG chạy trên T-SQL.
- `docsData/`: thêm `oracleDocs.ts`, `mssqlDocs.ts` cho hover/signature help. Tier 3.
- `utils/dumpBuilder.ts`: thứ tự statement đang được unit-test và **load-bearing**. Thêm dialect nghĩa là thêm case vào `buildSql()` (`INSERT ALL` cho Oracle, `SET IDENTITY_INSERT` cho MSSQL) và **thêm test tương ứng**, không sửa test cũ.
- `utils/connKey.ts`: `connKey` cho MSSQL phải gồm instance name (`mssql:host:port\instance`), nếu không hai instance trên cùng host dùng chung key — đúng lỗi mà `connKey` sinh ra để chữa. Oracle: gồm service name.
- i18n: `en.ts` là source of truth, `vi.ts`/`ja.ts` là `typeof en` → key thiếu là **compile error**. Không có cách nào quên.

---

## 7. Luật của repo áp dụng cho mọi command mới (không được lơ)

1. **Không nhận `tauri::State<'_, AppState>`** — đọc bằng `crate::state::require_state()?`.
2. **Bọc thân hàm trong `Box::pin(async move { … }).await`.**
   Vi phạm một trong hai → `STATUS_STACK_OVERFLOW` **chỉ ở release build**, `tauri dev` hoàn toàn im lặng. Với `connect_db` phình thêm hai nhánh driver (nó đã là hàm lớn nhất của app), đây là rủi ro thật: reproduce bằng `npx tauri dev --release` chạy từ terminal.
3. Đăng ký ở `app/handlers.rs` — quên thì lỗi runtime "unknown command", compiler không bắt.
4. Không đặt `session`/`key`/`uuid` cạnh nhau trong tên mới (heuristic CodeQL → false positive `rust/cleartext-storage-database`).
5. `npm run lint:rust` đang **zero warning**; giữ nguyên. Không thêm `#[allow]` thứ tư ở đầu `lib.rs` mà không viết lý do bên cạnh.
6. Comment mới viết **tiếng Anh**; string người dùng thấy đi qua i18n; error literal trong Rust viết tiếng Việt và **phải** có entry trong `backendErrors.ts`.
7. `split_sql_statements` (Rust) ↔ `src/sql/statements.ts` là **cặp hand-synced**. Cả `GO` của MSSQL và `/` của Oracle đều rơi vào cặp này. Lệch nhau = người dùng chạy một câu khác câu đang được highlight.
8. Tauri capabilities (`src-tauri/capabilities/default.json`) hiện tối thiểu (`core:default`, `dialog:default`, `fs:default`) — chỉ cần xem lại nếu đi đường `rust-oracle` với lựa chọn (b)/(c) của §4.1.5, vì lúc đó app phải đọc thư mục Instant Client bundle/tải về. Với `oracle-rs`, hoặc với (a), không cần mở thêm quyền nào: việc load thư viện do ODPI-C làm ở tầng OS, không đi qua Tauri fs.

---

## 8. Rủi ro, xếp theo mức có thể giết cả kế hoạch

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| 1 | **`oracle-rs` chưa chín**: 0.1.7, một tác giả, im 5,5 tháng, và dừng giữa lúc còn sửa lỗi parse row → nguy cơ **giá trị ô sai im lặng** | Spike §4.1.4 với điều kiện nghiệm thu là ĐỌC ĐÚNG, không phải compile được. Giảm nhẹ thật sự: MIT/Apache-2.0 + không phụ thuộc lib Oracle = **fork được** nếu bị bỏ rơi. |
| 1b | **Nếu phải dùng `rust-oracle`**: Instant Client (a/b/c), và với (b) là +110MB installer **cộng** câu hỏi AGPL × OTN | Chốt §4.1.5 trước khi viết code. Đề xuất (a) để câu hỏi license không phát sinh. Cả hai đường đều bí → chỉ làm SQL Server. |
| 2 | Driver Oracle blocking không ghép được với khuôn `Arc`-clone + `spawn_blocking` | **Chỉ áp dụng cho `rust-oracle`.** `oracle-rs` là async trên Tokio nên rủi ro này biến mất cùng lựa chọn driver (§4.1.2) |
| 3 | 15 thân hàm dựng row × 2 luật (uniquify, decode-by-index) | Một tệp một funnel, cùng thứ tự hàm; test `SELECT *` có tên cột trùng trên **mỗi** dialect |
| 4 | 62 `match` + 168 chuỗi phình thành 5 nhánh nếu bỏ phase 1 | Phase 1 là điều kiện tiên quyết, không phải "nice to have" |
| 5 | `_ =>` catch-all trả lời sai âm thầm (`qualified()` mất schema, `quote_ident` may mắn đúng) | Việc đầu tiên của phase 1: xoá mọi catch-all liên quan dialect |
| 6 | Không có Oracle/MSSQL để test | Docker: `mcr.microsoft.com/mssql/server:2022-latest`, `container-registry.oracle.com/database/free`. Test đánh `#[ignore]` để `cargo test --lib` vẫn offline |
| 7 | Không có ANTLR parser cho plsql/tsql | Chấp nhận `genericsql` + đường degraded; nói rõ trong release note |
| 8 | Regression trên 3 dialect hiện có do refactor phase 1 | 130 test Rust + Vitest phải xanh **trước và sau** mỗi commit của phase 1; phase 1 không đổi hành vi nào |
| 9 | Binary/installer phình | Đo `npm run build` trước/sau. `tiberius` nhỏ; `oracle-rs` dùng lại rustls/hmac/sha2/thiserror/chrono ĐÃ có trong `Cargo.lock`, chỉ `rand 0.8` là mới; ODPI-C ~1MB static. Vấn đề thật chỉ tồn tại ở đường Instant Client (#1b) |
| 10 | `connect_db` (hàm lớn nhất app) phình thêm 2 nhánh → stack overflow release | Tách mỗi nhánh driver thành hàm `async` riêng được `Box::pin`, không viết inline |

---

## 9. Lộ trình đề xuất

| Phase | Nội dung | Chi phí | Có gì bán được |
|---|---|---|---|
| 0 | Spike: `tiberius` connect + `SELECT`; **`oracle-rs` đọc đúng một schema thật** theo điều kiện nghiệm thu §4.1.4 | 4–5 ngày | Chọn được driver Oracle, và biết phase 3 tốn 20 hay 30 ngày |
| 1 | Seam dialect: `dialect.rs`, `trait DialectSql`, xoá `_ =>`, `page_clause`, `fk_checks_sql -> Vec<String>` | 5–8 ngày | Không (refactor thuần) |
| 2a | SQL Server Tier 1 | 8–10 ngày | **DB browser SQL Server đọc được** |
| 2b | SQL Server Tier 2 + Windows auth + named instance | 7–10 ngày | Sửa dữ liệu, DDL, transaction |
| 3a | Oracle Tier 1 (driver do phase 0 chốt) | 10–14 ngày | **DB browser Oracle đọc được** |
| 3b | Oracle Tier 2 | 8–12 ngày | Sửa dữ liệu, DDL, transaction |
| 4 | Tier 3 cho cả hai | 10–15 ngày | Object phụ, properties, process monitor |
| 5 | Tier 4 cho cả hai (restore, compare, datagen) | 15–20 ngày | Ngang bằng tính năng |

Tổng: **~66–93 ngày** cho ngang bằng đầy đủ hai engine. **~20–25 ngày** cho SQL Server đọc + ghi — mốc đáng ship đầu tiên.

---

## 10. Việc phải quyết trước khi bắt đầu

1. **Driver Oracle nào**: `oracle-rs` (thin, Rust thuần, async, không Instant Client, nhưng 0.1.7) hay `rust-oracle` (thick, chín, nhưng blocking + Instant Client)? Đây là câu hỏi **duy nhất** cần trả lời trước, và nó được trả lời bằng spike §4.1.4 chứ không bằng thảo luận. Chỉ khi rơi về `rust-oracle` mới phát sinh câu hỏi phụ: Instant Client nằm ở đâu (a/b/c), và nếu (b) thì hai câu cho pháp lý (§4.1.5).
2. **Oracle "database"**: map schema → slot database (A), hay PDB → database (B)? (§4.2)
3. **Có làm phase 1 không?** Bỏ nó thì phase 2 xong nhanh hơn khoảng một tuần và mọi phase sau chậm hơn mãi mãi.
4. **Phiên bản tối thiểu**: Oracle 12c+ (để có `OFFSET/FETCH`) và SQL Server 2012+ — hay phải đỡ cả 11g? Câu này **quyết luôn câu 1**: `oracle-rs` chỉ đỡ 12.1+, nên nếu bắt buộc có 11g thì driver đã bị chốt là `rust-oracle` và §4.4 phải thêm nhánh `ROWNUM` lồng.
