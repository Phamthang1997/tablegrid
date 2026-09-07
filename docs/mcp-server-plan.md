# Kế hoạch: MCP Server nội bộ (Model Context Protocol)

Mở một **Local MCP Server** trong tiến trình TABLEGRID để các AI client (Claude Desktop, Claude Code,
Cursor, Raycast, VS Code Copilot) truy vấn được database qua chính những kết nối người dùng đã mở
trong app — không phải khai lại connection string, password hay private key SSH ở từng IDE.

Bản này viết lại bản đầu tiên. Bản đầu đúng về mục tiêu nhưng sai ở năm chỗ va thẳng vào kiến trúc
hiện tại; §0 ghi lại cả năm để khỏi đề xuất lại. Thay đổi lớn nhất về phạm vi: **V1 chỉ đọc**. Lớp
phê duyệt tương tác (Human-in-the-Loop) chính là thứ máy móc mà `src/utils/safeMode.ts` đã **cố ý từ
chối xây**, nên nó không thể là một gạch đầu dòng trong tuần 2 — nó là cả V2.

Phạm vi đã chốt:

| Hạng mục | Chốt |
|---|---|
| Transport | **Streamable HTTP** qua SDK chính thức `rmcp`, bind loopback. Không dựng endpoint `/sse` riêng (§2.3) |
| Ghi dữ liệu qua MCP | **Ngoài phạm vi V1.** Không có `execute_mutation` cho tới khi có lớp 5 (§3.5) |
| Cầu stdio (`--mcp-stdio`) | **Đã làm** — một `if` trước `tauri::Builder`, không cần single-instance. §0.4 lo quá mức; §7 ghi lý do làm sớm |
| Kết nối được phơi cho AI | **Mặc định TẮT**, người dùng tự tích từng kết nối (§3.3) |
| Đường thực thi | Pooled connection, **không** nhảy vào transaction thủ công của người dùng (§2.2) |
| Redis | Ngoài phạm vi (§7) |

---

## 0. Năm điều bản đầu nói sai

### 0.1. "Connection Safe Mode Filter" không tồn tại ở Rust

Bản đầu vẽ lớp 3 như một bộ lọc trong backend. Không có bộ lọc đó. Có **hai** thứ khác nhau bị gộp
làm một:

| | Safe Mode | Read-only |
|:--|:--|:--|
| Ở đâu | Frontend, `localStorage` (`tf_safe_mode`) | Rust, `ConnEntry.read_only` |
| Phạm vi | Per-**server** (`connKey`) | Per-**connection** (`conn_id`) |
| Cổng chặn | Trước `invoke()` duy nhất của `dbHelper` | [`read_only.rs`](../src-tauri/src/database/read_only.rs), trong ba funnel |
| MCP thấy được? | **Không** | Có |

[`safeMode.ts`](../src/utils/safeMode.ts) nói rõ lý do gate nằm ở frontend: nó cần một hộp thoại, và
nó ngồi đúng chỗ mọi lời gọi đi qua. Request MCP không đi qua `dbHelper`, và chính sách lại nằm trong
`localStorage` mà Rust không đọc. Kết luận: **MCP thừa hưởng read-only miễn phí, và không thừa hưởng
gì từ Safe Mode.**

### 0.2. `execute_query` sẽ tự động nhảy vào transaction thủ công của người dùng

[`should_route()`](../src-tauri/src/tx/route.rs#L30) được hỏi ở đầu cả ba funnel, và nó trả `true`
khi `!autocommit || open` — **trước khi** xét ai là người gửi câu lệnh. Hệ quả nếu MCP dùng thẳng
`execute_raw_sql_generic` với `conn_id` của người dùng:

- Người dùng đang bật commit thủ công → một câu `SELECT` của AI **tự phát `BEGIN`** trên phiên của
  họ. `TxControl` trên thanh tiêu đề sáng lên một transaction họ không mở.
- Khi có ghi (V2), câu lệnh của AI nằm **trong** transaction người dùng và đếm vào pending counter.
  Người dùng bấm Commit là commit luôn thứ AI viết.

Đây là loại tác dụng phụ vô hình mà repo viết cả đoạn văn để tránh. Xử lý ở §2.2.

### 0.3. Chặn theo từ khóa là cơ chế sai, và "AST" thì không có

"Nếu câu lệnh **chứa** `DROP DATABASE` / `TRUNCATE`" là substring-match: một comment hay một string
literal cũng trigger, còn `/*x*/DROP` thì lọt. Repo đã có bản đúng và đã dùng ở nhiều nơi —
[`is_write_stmt()`](../src-tauri/src/tx/effect.rs#L146) đọc 4 token đầu trên text đã bỏ comment,
`statementHead()`/`maskForSplit()` mask string và comment trước khi đọc keyword,
`findUnsafeStatements()` bắt đúng cái "UPDATE không có WHERE".

Bản đầu còn viết "kiểm tra cú pháp **AST**" ở Giai đoạn 2. **Backend không có SQL AST.** Parser ANTLR
chỉ tồn tại ở frontend qua `monaco-sql-languages`. Kéo một AST vào Rust là một dependency lớn và một
quyết định riêng, không phải một gạch đầu dòng.

### 0.4. `TABLEGRID.exe --mcp` mở một app thứ hai, không phải một cầu stdio

[`main.rs`](../src-tauri/src/main.rs) chỉ gọi `TABLEGRID::run()`; [`run.rs`](../src-tauri/src/app/run.rs)
dựng thẳng `tauri::Builder` + webview. Không có arg parsing ở bất kỳ đâu, và app không cài plugin
single-instance. Chạy `TABLEGRID.exe --mcp` sẽ **mở cửa sổ thứ hai với `ConnRegistry` rỗng** — không
thấy một kết nối nào của instance đang chạy. Bản đầu có nhắc "IPC / Named Pipe" nhưng đó là cơ chế
thứ ba chưa đặc tả, và nó lại phải xuyên qua đúng cái HTTP server mà Lựa chọn 1 định thay thế.

### 0.5. Loopback **không** chặn được trang web

Bản đầu ghi "Loopback-only Binding ➔ Chặn 100% truy cập từ mạng ngoài". Chặn được máy khác, không
chặn được **trình duyệt của chính người dùng**: một trang web bất kỳ có thể `fetch('http://127.0.0.1:45124/…')`,
và với DNS rebinding thì cả `Host` cũng giả được. Bearer token chặn được, nhưng token là thứ có thể
rò. Lớp thiếu là **kiểm `Origin`/`Host`** — §3.1.

---

## 1. Phạm vi

### 1.1. V1 — chỉ đọc

Đủ để phục vụ đúng use case ở phần kết của bản đầu ("kiểm tra bảng orders xem có đơn nào lỗi hôm
nay"), và gần như chỉ là một lớp vỏ JSON-RPC bọc quanh command đã có.

- Transport Streamable HTTP trên `127.0.0.1`, kiểm `Origin`/`Host`, bearer token trong keyring OS.
- 5 tool đọc + `TABLEGRID_query` giới hạn ở câu lệnh đọc.
- Kết nối phải được người dùng **tích chọn** mới thấy được.
- Giới hạn số dòng trả về, áp `statement_timeout` sẵn có.
- Audit log sống trong bộ nhớ, hiện realtime trên Settings.

### 1.2. V2 — ghi có phê duyệt

- `TABLEGRID_mutate` + lớp phê duyệt tương tác (§3.5), **và** việc hòa giải nó với Safe Mode để
  repo không có hai chính sách phê duyệt lệch nhau.
- ~~Cầu stdio cho client chỉ nói stdio.~~ — **đã làm trong V1**, sớm hơn kế hoạch, vì một client mục
  tiêu thực sự cần (§6 Bước 3, bẫy 6). Nó cũng là đường duy nhất không đặt token vào config client.
- Audit log ghi ra tệp.

### 1.3. Ngoài phạm vi (§7 ghi lý do)

Redis, truy vấn liên-kết-nối, MCP Resources/Prompts, OAuth.

---

## 2. Kiến trúc

### 2.1. Handler MCP gọi tầng nào

**Không gọi các hàm `#[tauri::command]`.** Chúng nhận `state: tauri::State<'_, AppState>`, thứ chỉ
tồn tại trong ngữ cảnh một lời gọi IPC. Handler MCP chạy trong task axum của riêng nó, nên nó đi
đường mà `state/app_handle.rs` đã mở sẵn cho đúng tình huống này:

```rust
use tauri::Manager;
let state = app.state::<crate::AppState>();
let ctx = state.connections.acquire(&conn_id)?;   // cùng một cửa duy nhất
```

`AppHandle` đã được park trong [`app_handle.rs`](../src-tauri/src/state/app_handle.rs) từ setup, cho
đúng lý do này: "các tầng nhận `&DbConnection` mà không nhận `AppState`". MCP là tầng thứ ba như vậy.
Ba tầng đọc chung một `AppHandle` đã park, không dựng bản sao thứ hai của registry.

### 2.2. Một funnel mới, không nhân bản một dòng nào

Quyết định: **truy vấn của MCP chạy trên pooled connection, không bao giờ route vào phiên thủ công**
(lý do ở §0.2). AI là bên thứ ba, không phải phiên của người dùng; để một request từ ngoài mở
transaction của người dùng là tác dụng phụ vô hình.

Hiện `execute_raw_sql_generic` gộp ba việc trong một hàm ([`exec/raw.rs:22`](../src-tauri/src/database/exec/raw.rs#L22)):
kiểm read-only → hỏi route → chạy trên pool. Tách đúng một nhát, không nhân bản thân hàm:

```rust
// Cửa cũ, chữ ký không đổi — mọi call site hiện tại giữ nguyên.
pub(crate) async fn execute_raw_sql_generic(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    if crate::tx::should_route(conn, &sql) {
        return crate::tx::run_raw(conn, sql).await;
    }
    execute_raw_sql_pooled(conn, sql).await
}

// Cửa của MCP: cùng thân, bỏ đúng một câu hỏi route.
pub(crate) async fn execute_raw_sql_pooled(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    match &conn.kind { /* ba nhánh y như cũ, gọi sqlite_raw / pg_raw / mysql_raw */ }
}
```

Ba thân dựng row (`sqlite_raw`/`pg_raw`/`mysql_raw`) vốn đã tách sẵn đúng vì lý do này, nên hai luật
bắt buộc ở mọi row-building site (`uniquify_columns` trước khi dựng row, decode **theo chỉ số**)
không bị nhân đôi. `reject_if_read_only` được gọi ở cả hai cửa — rẻ, và không phụ thuộc vào việc ai
nhớ gọi.

Hai hệ quả phải ghi vào tài liệu người dùng, không phải giấu:

- **Postgres / MySQL**: AI chỉ đọc được trạng thái **đã commit**. Dữ liệu người dùng vừa ghi mà chưa
  commit thì AI không thấy. Đúng ngữ nghĩa — cùng lý do `compare/` đọc qua pool riêng.
- **SQLite**: `DbConnection::Sqlite` là **một** handle dùng chung, nên AI vẫn thấy dữ liệu chưa
  commit dù có route hay không. Không sửa được mà không mở thêm handle thứ hai, và mở handle thứ hai
  trên cùng một tệp là `SQLITE_BUSY` — đúng thứ `find_sqlite()` sinh ra để tránh.

### 2.3. Transport — dùng SDK chính thức, không tự viết giao thức

**Chốt: `rmcp`**, crate chính thức của `modelcontextprotocol/rust-sdk`. Bản 3.1.4 phát hành
20/08/2026, 21.9M lượt tải, nhịp phát hành dày — không phải một crate bỏ hoang.

Nó implement spec **2026-07-28** (stable, tương thích ngược tới 2025-11-25). Con số đó chính là lý do
của quyết định: bản đầu tài liệu này viết theo transport **HTTP+SSE**, và ngay cả "Streamable HTTP
2025-03-26" cũng đã trễ **hai** revision. Thoả thuận version là thứ phải đúng theo spec đang sống,
không theo trí nhớ của người viết plan.

`rmcp` lo: JSON-RPC 2.0, `initialize` + thoả thuận version, `tools/list`, `tools/call`, session của
Streamable HTTP. Nó **không** lo phần host: nó cho một `StreamableHttpService` là `tower::Service` và
**không có helper bind/listen**.

→ `axum` vẫn vào nhưng đổi vai: chỉ để mount service đó và đặt middleware §3.1, không còn là nơi ta
tự dựng giao thức.

```toml
rmcp = { version = "3.1", features = ["transport-streamable-http-server"] }
```

**Cạm bẫy phải tránh: mọi feature `reqwest*`.** Chúng đều là client-side và kéo `reqwest 0.13` cùng
**một TLS stack thứ hai** bên cạnh rustls mà sqlx và redis đang dùng. Default features
(`base64, macros, server, schemars, transport-async-rw, uuid`) không gồm reqwest, nên giữ nguyên
default và chỉ bật thêm transport server là đủ.

Độ khớp phụ thuộc là điểm mạnh nhất của lựa chọn này: `hmac ^0.13`, `sha2 ^0.11`, `chrono ^0.4.38`,
`thiserror ^2`, `uuid ^1`, `tokio ^1`, `serde`/`serde_json` đều đã có sẵn đúng phiên bản trong cây.
Thật sự thêm mới chỉ có `hyper 1` + `http` + `tower` + `schemars` (+ `axum`).

`schemars` là default feature, và đó là quà: macro `#[tool]` sinh JSON Schema cho tham số tool **từ
chính struct Rust**, nên §4.1 không phải viết schema tay và schema không lệch được với struct.

**Pin chặt.** 5 bản trong ~3 tuần nghĩa là API còn chuyển động: khai `3.1`, đọc changelog trước mỗi
lần nâng, đừng để `cargo update` tự kéo.

Vẫn giữ: **không** thêm `tower-http`. Thứ duy nhất định dùng ở đó là CORS layer, mà §3.1 lại cố tình
không phát header CORS nào.

### 2.4. Vòng đời server và cửa sổ

- Server bật/tắt bằng command, trạng thái nằm trong `AppState`. Mặc định **tắt** ở lần chạy đầu.
- Server sống theo **tiến trình**, không theo cửa sổ — nó phục vụ được cả khi cửa sổ bị thu nhỏ.
- Đóng cửa sổ khi MCP đang chạy: thêm một blocker vào [`closeGuard.ts`](../src/utils/closeGuard.ts)
  chỉ khi **đang có request dở dang**, ưu tiên **thấp hơn** transaction chưa commit và job đang chạy
  — một truy vấn đọc của AI mất đi thì chạy lại được, dữ liệu chưa commit thì không. Không chặn chỉ
  vì server đang bật: người dùng sẽ không đóng nổi app.

### 2.5. Cây module

Theo luật của [`backend-module-split-plan.md`](backend-module-split-plan.md): mỗi tệp một nhiệm vụ,
`mod.rs` chỉ có `mod` + `pub use` và khối comment đầu tệp giải thích giao thức.

```
src-tauri/src/mcp/
  mod.rs        — khối comment: revision spec (do bản rmcp đã pin quy định) và 5 lớp phòng thủ
  server.rs     — mount StreamableHttpService vào axum, bind, trạng thái bật/tắt
  http.rs       — router, kiểm Origin/Host, middleware bearer token
  auth.rs       — token: sinh, cất keyring, so sánh constant-time
  policy.rs     — kết nối nào được phơi, phân loại câu lệnh, giới hạn dòng
  audit.rs      — ring buffer + emit event
  tools/
    mod.rs      — impl ServerHandler của rmcp: khai 6 tool
    catalog.rs  — list_connections / list_databases / list_tables / describe_table
    data.rs     — preview_table / query
  commands.rs   — #[tauri::command] cho UI: bật/tắt, đọc token, regenerate, đọc log
```

**Không có `protocol.rs`** — `rmcp` lo phần đó (§2.3). Đang viết một hàm parse JSON-RPC ở thư mục này
là dấu hiệu đi sai đường.

Khai mọi command mới vào [`app/handlers.rs`](../src-tauri/src/app/handlers.rs) — quên là lỗi runtime
"unknown command", compiler không bắt được. Và **mỗi command mới phải được phân loại trong
[`safeMode.ts`](../src/utils/safeMode.ts)**: `safeMode.test.ts` đọc `dbHelper.ts` và fail khi có
command chưa phân loại. Các `mcp_*` command là `internal` (chúng cấu hình app, không phải câu lệnh
người dùng chạy trên database) — trừ `mcp_regenerate_token`, đáng cân nhắc để `write` vì nó cắt đứt
mọi client đang kết nối.
**Ngôn ngữ thông báo lỗi**: lỗi MCP trả về cho **AI client**, không phải cho UI TABLEGRID → viết
**tiếng Anh** và **không** đi qua `backendErrors.ts`. Cùng luật với comment trong SQL script của
`compare/` và với `failed[].error` của Redis. Chỉ chuỗi hiện trên Settings/audit log mới là key i18n.

---

## 3. Năm lớp phòng thủ

```
[ AI Request ]
      │
      ▼  1. Bind 127.0.0.1  +  kiểm Origin/Host      ➔ máy khác không tới được, trang web không tới được
      ▼  2. Bearer token (keyring OS)                 ➔ chỉ client được cấu hình mới gọi được
      ▼  3. Kết nối phải được tích phơi (mặc định TẮT)➔ prod không lộ vì quên
      ▼  4. read_only + phân loại câu lệnh            ➔ V1 chặn mọi thứ không phải đọc
      ▼  5. Phê duyệt tương tác  (V2)                 ➔ ghi thì hỏi người
```

### 3.1. Loopback + kiểm `Origin`/`Host`

Bind `127.0.0.1`, không bao giờ `0.0.0.0`. Thêm vào đó, vì lý do ở §0.5:

- **Từ chối request có `Origin`** trỏ tới một website (chỉ chấp nhận không có `Origin`, hoặc các
  origin đã whitelist cho client desktop). Trình duyệt luôn gắn `Origin` cho cross-origin fetch;
  một client desktop thì không.
- **Kiểm `Host`** đúng là `127.0.0.1:<port>` hoặc `localhost:<port>` → chặn DNS rebinding.
- **Không phát bất kỳ header CORS nào.** Không có `Access-Control-Allow-Origin` thì kể cả request
  lọt qua, trình duyệt cũng không đọc được response.

### 3.2. Token trong keyring OS

Không có crate `rand` trong cây phụ thuộc và không cần thêm: `uuid` đã bật feature `v4`, nên
`Uuid::new_v4()` hai lần cho 256 bit entropy từ nguồn của HĐH.

Cất ở [`credentials/secret_store.rs`](../src-tauri/src/credentials/secret_store.rs) (keyring OS,
`SERVICE = "TABLEGRID"`) với `profile_id = "__mcp__"`, `field = "token"` — **không** ở `localStorage`,
vì file profile của Tauri đọc bằng tay được. Module đã tồn tại; không thêm kho thứ hai.

So sánh token bằng vòng lặp **constant-time** (hoặc so sánh digest SHA-256 — `sha2` đã có sẵn trong
`Cargo.toml`), không phải `==` trên `String`.

### 3.3. Danh sách kết nối được phơi — mặc định TẮT

Đây là lớp bản đầu ghi đúng nhưng để lẫn trong mục UI. Nó là một lớp bảo mật, và nó có **khuôn sẵn
trong repo**: `set_connection_read_only`.

- Cờ nằm cạnh `read_only` trong `ConnEntry`, đặt qua `set_connection_mcp_exposed(conn_id, bool)`.
- **KHÔNG lưu bền, và đó là bản đã sửa của mục này.** Bản đầu viết: giữ trong `localStorage` khóa
  theo `connKey`, đẩy xuống Rust lúc connect — lý do là `conn_id` được mint mới mỗi lần connect nên
  khóa theo nó sẽ bốc hơi. Lý do đó đúng, nhưng kết luận thì sai, vì **`connKey` cố ý không chứa tên
  database**: dev và prod trên cùng một MySQL server có cùng một `connKey`. Phục hồi cờ theo
  `connKey` nghĩa là session sau, connect vào prod trên server đó, cờ sống lại — tức tạo ra đúng cái
  hại mà doc comment của `ConnEntry::mcp_exposed` cấm bằng chữ ("*'I shared dev' must not quietly
  become 'I shared prod on the same server'*"). Hai câu không thể cùng đúng.
  Bản đang chạy vì thế **chỉ sống trong RAM**: `mcp_exposed: false` ở mọi chỗ mint `ConnEntry`,
  không một dòng `localStorage` nào. Tick lại mỗi lần mở app là **friction cố ý**, ở đúng lớp quyết
  định AI đọc được database nào — và nó xoá luôn rủi ro "hai nơi giữ một sự thật" mà §8 từng ghi.
  Cái được lưu bền là **công tắc server** (`tf_mcp_autostart`/`tf_mcp_port`, xem `utils/mcpPrefs.ts`),
  vì một listener chạy mà chưa tick gì thì không lộ gì cả.
- **Mặc định `false`.** Một kết nối production mở sẵn không được lộ cho AI chỉ vì người dùng chưa
  vào Settings bao giờ.
- `TABLEGRID_list_connections` chỉ liệt kê kết nối đã phơi; mọi tool khác từ chối `conn_id` chưa
  phơi bằng **cùng một thông báo** như `conn_id` không tồn tại — không xác nhận cho client biết có
  một kết nối tồn tại mà nó không được thấy.

### 3.4. Read-only + phân loại câu lệnh (không grep từ khóa)

Hai tầng, cả hai đã có code:

1. `reject_if_read_only` trong funnel (§2.2) — bắt kết nối người dùng đã đánh dấu chỉ đọc.
2. Ở `policy.rs`, trước khi gửi đi: tách câu lệnh bằng `split_sql_statements()` (cùng splitter của
   SQL editor, hiểu `DELIMITER`, `$$…$$`, thân trigger), rồi mỗi câu phải là đọc.

Định nghĩa "đọc" trong V1 là **danh sách trắng**, dùng lại đúng tập của `READ_HEADS` trong
`safeMode.ts` (`SELECT`, `EXPLAIN`, `SHOW`, `DESCRIBE`, `DESC`) đọc trên text đã strip comment. Mọi
thứ khác — kể cả `WITH` và mọi dạng không nhận ra — bị từ chối, cùng hướng bảo thủ với
`is_write_stmt()`: từ chối nhầm thì tốn một câu giải thích cho AI, cho lọt nhầm thì mất dữ liệu.

Nhiều câu lệnh trong một lần gọi: **từ chối**. Một tool call là một câu lệnh. Nới ra thì việc phân
loại phải đúng với từng câu trong một chuỗi mà AI ghép, và đó là bề mặt tấn công không cần thiết cho
một tính năng chỉ đọc.

### 3.5. Phê duyệt tương tác — V2, và tại sao nó không thể ở V1

Cơ chế cần: park request trong Rust → emit event → hộp thoại hỏi → trả lời qua channel → re-enter.
`safeMode.ts` mô tả đúng chuỗi đó và ghi rõ nó **cố ý không xây**. Xây nó là công việc chính của V2,
kèm hai câu hỏi phải trả lời trước khi viết dòng đầu tiên:

- **Hợp nhất hay song song với Safe Mode?** Hai chính sách phê duyệt lệch nhau (một per-server ở
  localStorage, một per-request ở Rust) là thứ người dùng chỉnh cái này rồi tưởng cái kia cũng đổi.
- **Timeout khi không ai trả lời?** Client MCP sẽ chờ. Phải có hạn và một câu trả lời rõ ràng cho
  client ("người dùng không phản hồi"), không để treo.

**Đã quyết ngày 2026-09-04, và đây là câu trả lời cho cả hai câu hỏi trên.**

1. **Chung cơ chế, KHÔNG chung chính sách.** Safe Mode không gác được MCP dù có muốn: nó nằm ở
   frontend, trong đúng một chỗ là hàm `invoke()` cục bộ của `dbHelper`, còn request MCP đi
   Rust→Rust và không hề qua đó. Nên `mcp/approval.rs` xây đúng cái máy mà `safeMode.ts` cố ý
   tránh. Cái được chia sẻ là *hình dạng câu hỏi* và luật "một lời hỏi cho một hành động", không
   phải cấu hình. Cổng MCP **luôn bật, không có chế độ tắt** — và đó chính là cách nỗi lo "hai
   chính sách lệch nhau" được đóng: không có chính sách thứ hai để lệch. `silent` của Safe Mode
   nghĩa là "tôi đang tự gõ, đừng hỏi nữa", không cách đọc nào kéo nó sang một request do dịch vụ
   bên ngoài gửi.
2. **Quyền ghi là một tick RIÊNG cho từng kết nối, mặc định TẮT** (`ConnEntry::mcp_write`). Phơi
   để đọc và cho phép ghi là hai quyết định khác nhau; gộp lại thì mọi kết nối đã phơi đều có thể
   bị dội hộp thoại, mà mệt là đường dẫn tới bấm Đồng ý theo phản xạ — đúng thứ hộp thoại sinh ra
   để chặn. Bỏ tick phơi thì tick ghi **rơi theo**: một quyền tự quay lại là hành vi tệ nhất một
   quyền có thể có.
3. **60 giây rồi từ chối.** Client bị chặn suốt thời gian đó nên đây là ngân sách chứ không phải
   phép lịch sự: đủ để người dùng đổi cửa sổ và ĐỌC câu lệnh, đủ ngắn để client không tưởng server
   chết. Cố ý không dính gì tới `MAX_TIMEOUT` 30s — cái đó chặn database chạy bao lâu, đọc không
   phải là chạy. Hết giờ thì Rust bắn `mcp-approval-resolved` để hộp thoại tự đóng, vì để lại hai
   cái nút cho một request đã bị từ chối nghĩa là một nút Đồng ý bấm vào không có gì xảy ra.

Và khi có ghi thì §0.2 quay lại thành câu hỏi thật: một `UPDATE` của AI chạy trên pooled connection
(§2.2) **không** nằm trong transaction người dùng — nghĩa là nó tự commit ngay, không rollback được
bằng nút Rollback của người dùng. Hộp thoại phê duyệt phải nói ra điều đó.

---

## 4. Tools

### 4.1. Bảng ánh xạ

Sáu tool V1, gần như toàn bộ đã có command tương ứng — phần việc thật là vỏ JSON-RPC và policy.

| Tool | Nguồn dữ liệu đã có | Ghi chú |
|:--|:--|:--|
| `TABLEGRID_list_connections` | `ConnRegistry::list()` | Đã trả sẵn `connId`/`db`/`dialect`/`serverId`/`schema`/`readOnly`. Lọc theo §3.3, **bỏ** `pending` (rò rỉ hoạt động của người dùng) |
| `TABLEGRID_list_databases` | `list_databases` | |
| `TABLEGRID_list_tables` | `get_tables` | Đã phân biệt table/view, gồm cả matview của Postgres |
| `TABLEGRID_describe_table` | `get_table_schema` + `get_full_catalog` | Cột, kiểu, nullable, PK, FK, index |
| `TABLEGRID_preview_table` | `get_table_data` | SQL do ta dựng → `LIMIT` đặt vào SQL được (§4.3) |
| `TABLEGRID_query` | `execute_raw_sql_pooled` | Chỉ câu lệnh đọc (§3.4) |

Đặt tên `TABLEGRID_query` chứ không phải `TABLEGRID_execute_query`: tên tool là thứ AI đọc để chọn,
và ở V1 không có tool "execute" nào khác để phân biệt.

**Không** tách `execute_query` / `execute_mutation` làm hàng rào. Tách hai tool là tốt cho mô tả,
nhưng AI hoàn toàn gửi được `UPDATE` qua tool đọc — hàng rào phải là classifier ở server (§3.4), và
khi đã có classifier thì việc tách chỉ còn là chuyện đặt tên.

### 4.2. Hình dạng kết quả

```json
{
  "columns": ["id", "email", "created_at"],
  "rows": [[1, "alex@example.com", "2026-01-15T08:30:00Z"]],
  "row_count": 1,
  "truncated": false,
  "execution_time_ms": 12
}
```

**Mảng-của-mảng, không phải object keyed by column name.** Bản đầu chọn đúng, và lý do đáng ghi lại:
`SELECT *` qua vài JOIN trả về nhiều cột trùng tên (sakila trả 5 cột `last_update`), và một object
JSON sẽ nuốt mất tất cả trừ một. Funnel trả về `{columns, data:[{col: val}]}` với `columns` đã qua
`uniquify_columns()` (`last_update (2)`, `last_update (3)`…), nên MCP chiếu theo thứ tự `columns` là
đủ và an toàn — không phải sửa gì trong funnel.

`truncated` là trường bắt buộc, không phải tuỳ chọn: AI kết luận "chỉ có 100 đơn lỗi" từ một kết quả
bị cắt âm thầm là sai lệch tệ hơn hẳn một lỗi.

### 4.3. Giới hạn dòng

Hai đường khác nhau, và không được làm giống nhau:

- **`preview_table`**: SQL do ta dựng → đặt `LIMIT` thẳng vào SQL. Rẻ, database làm việc cắt.
- **`query`**: SQL do AI viết → **cắt sau khi decode**, không chèn `LIMIT`. Chèn `LIMIT` vào câu lệnh
  người khác viết là sai với câu đã có `LIMIT`, sai với `UNION`, sai với CTE, và làm đúng thì cần
  đúng cái AST mà §0.3 nói là không có.

Cái giá của lựa chọn thứ hai — kết quả đầy đủ vẫn được decode vào bộ nhớ trước khi cắt — là có thật
và được chấp nhận ở V1. Nếu nó thành vấn đề, đường ra đã có sẵn: `stream_sql_statements()` đẩy theo
từng lô và dừng được giữa chừng bằng cờ cancel; chuyển sang nó là một thay đổi khu trú, không phải
thiết kế lại.

Mặc định 100 dòng, chỉnh được trong Settings, trần cứng 1000.

### 4.4. Timeout

Dùng lại `stmt_timeout(&ctx.server().config())` + `with_timeout(...)` y như
[`execute_query`](../src-tauri/src/database/commands/query.rs#L15) — giới hạn người dùng đã đặt cho
server đó áp cho cả AI, không có đường vòng. Không cần cơ chế hủy riêng ở V1: không có UI nào để bấm
Stop cho một truy vấn của AI, và timeout đã là cái hãm.

**Đoạn trên đúng một nửa, và nửa sai đã được sửa.** `stmt_timeout()` đọc `statementTimeoutSecs` rồi
`unwrap_or(0)`, và `0` nghĩa là **không có timeout** — mà đó là mặc định. Nên "timeout đã là cái hãm"
mô tả một cái hãm không tồn tại trên kết nối thông thường; ghép với §4.3 (cố ý decode hết rồi mới
cắt) thì một `SELECT * FROM bảng_10M` của AI không có gì chặn.

Đường MCP vì thế có trần **riêng**: `policy::mcp_timeout()` trả về **min(giới hạn của người dùng,
`MAX_TIMEOUT` = 30s)**, và `Target::timeout` không còn là `Option` — một lượt đọc MCP **luôn** có hạn.
Đặt thấp hơn là người dùng muốn ngặt hơn, và điều đó áp cho AI y như áp cho họ; đặt cao hơn (hoặc
không đặt) thì vẫn về trần. Cơ sở của việc tách trần này nằm ngay trong chính đoạn trên: người dùng
**thấy** truy vấn của mình và bấm Stop được, truy vấn của AI thì không — chỗ nào timeout là cái hãm
duy nhất thì nó không được phép là tuỳ chọn.

---

## 5. Cấu hình & UI

### 5.1. `McpServerSettingsModal.tsx`

Dựng từ [`Modal.tsx`](../src/components/Modal.tsx) như mọi hộp thoại khác — không tự viết overlay.

- Công tắc bật/tắt + trạng thái (`🟢 127.0.0.1:45124` / `🔴 Đã dừng`).
- Token: hiện dạng ẩn, nút Copy, nút Regenerate (cảnh báo rõ: mọi client đang kết nối sẽ đứt).
- Danh sách kết nối đang mở, mỗi dòng một checkbox "phơi cho AI" (§3.3). Đây là phần quan trọng
  nhất của màn hình này — đặt nó **trên** phần snippet.
- Giới hạn dòng trả về.
- Audit log realtime.

Một `McpStatusPill` trên thanh tiêu đề chỉ nên xuất hiện **khi server đang bật**, và nhấp nháy khi
có request — thanh tiêu đề đã chật (xem lý do `TxControl` gom hết vào một nút).

### 5.2. Port: không tự nhảy

Bản đầu ghi "tự động chuyển port tiếp theo nếu bị chiếm dụng" ở §5.1, rồi in cứng `45124` vào snippet
`.cursor/mcp.json` ở §5.2. Hai điều đó đánh nhau: app nhảy sang 45125 là file người dùng đã copy
thành sai, và không có gì báo cho họ biết.

Chốt: **port cố định, chỉnh được trong Settings, bị chiếm thì báo lỗi rõ ràng** ("cổng 45124 đang bị
tiến trình khác dùng — đổi cổng trong Cài đặt"). Và snippet 1-click được **sinh ra từ cổng đang bind
thật**, không phải từ hằng số.

### 5.3. Audit log sống ở Rust

Log sinh ra trong Rust, còn `queryHistory.ts`/`jobs.ts` đều là store của frontend — nếu chọn khuôn
đó, mọi request đến lúc không có cửa sổ nào lắng nghe sẽ mất, mà đó đúng là lúc log cần nhất.

Chốt V1: **ring buffer trong `AppState`** (cap 500 mục), emit event `mcp-request` cho UI vẽ realtime.
Không ghi tệp ở V1 — và **nói rõ trong UI** rằng log mất khi tắt app, chứ không để người dùng tự
tưởng là nó bền. Ghi tệp là việc của V2.

Mỗi mục: thời gian, tên tool, `conn_id`, câu SQL (cắt bớt, có cờ `truncated` như `pendingSql` của
`tx/` đã làm), số dòng trả, thời gian chạy, kết quả (OK / bị từ chối ở lớp mấy). Ghi rõ **lớp nào từ
chối** là thứ khiến log này dùng được để gỡ lỗi thay vì chỉ để nhìn.

---

## 6. Lộ trình

Ước lượng của bản đầu (3 tuần cho cả ghi + phê duyệt + stdio) là lạc quan. Chia lại:

### V1 — chỉ đọc (~1.5–2 tuần)

Ngắn hơn ước lượng trước một chút vì `rmcp` nuốt trọn phần giao thức (§2.3); phần còn lại — Origin/token,
policy, 6 tool, UI, i18n ba ngôn ngữ — không đổi.

**Bước 1 — nền và bảo mật** (không có bước này thì không có gì được phép chạy)
- [x] Tắt `tauri dev` trước khi đụng `Cargo.toml` — thêm dependency là rebuild cả cây.
- [x] Thêm `rmcp` (chỉ `transport-streamable-http-server`, **không** feature `reqwest*`) + `axum` (§2.3).
- [x] `server.rs`: mount `StreamableHttpService`, bind loopback, bật/tắt qua `AppState`.
- [x] Kiểm `Origin`/`Host`, không phát header CORS (§3.1).
- [x] Sinh + cất token qua `secret_store.rs`; so sánh constant-time (§3.2).
- [x] Ghi bản `rmcp` đã pin + revision spec nó nói vào khối comment của `mcp/mod.rs`.

**Bước 1 xong.** `rmcp` 3.1.4 + `axum` 0.8.9 vào cây sạch, không kéo TLS stack thứ hai. 7 test mới
(6 thuần + 1 chạy qua socket thật: dựng server trên cổng tạm rồi gõ HTTP vào cả hai cửa). Bề mặt tool
cố tình để trống — chưa có lớp 3 và 4 thì chưa có gì được phép chạm vào database.

**Bước 2 — đường dữ liệu**
- [x] Tách `execute_raw_sql_pooled` khỏi `execute_raw_sql_generic` (§2.2). Một nhát, không nhân bản.
- [x] Cờ `exposed` trong `ConnEntry` + command đặt cờ, theo khuôn `set_connection_read_only` (§3.3).
- [x] `policy.rs`: danh sách trắng câu lệnh đọc, một-câu-một-lần, giới hạn dòng (§3.4, §4.3).
- [x] 6 tool (§4.1). Khai command mới vào `app/handlers.rs`. **Còn thiếu: phân loại trong `safeMode.ts`** —
      làm cùng Bước 3, khi `dbHelper` thực sự gọi các lệnh `mcp_*` (test chỉ đọc `dbHelper.ts`).

**Bước 2 xong, cộng một khoản nợ kỹ thuật phải trả giữa đường.** Thân tool chạm vào introspection →
funnel routed → `tx` → `AppHandle::emit`, và thế là **tầng cửa sổ của Tauri bị link vào binary test**:
exe test import `TaskDialogIndirect`/`SetWindowSubclass` (comctl32 **v6**), mà exe test không có
manifest nên Windows nạp comctl32 v5 và **cả 101 test cũ chết ngay lúc load** với
`STATUS_ENTRYPOINT_NOT_FOUND`. Ba việc đã làm để gỡ, và cả ba đều đáng giữ độc lập với MCP:

- `tx/` park một **closure phát event** thay cho `AppHandle` (`tx::set_emitter`).
- `state/app_handle.rs` bỏ hẳn `AppHandle`, đọc `AppState` đã park (`AppState` thành handle `Arc`).
- Ba thân introspection dùng chung với UI chuyển sang `database/introspect.rs` — **tệp không chứa
  `#[tauri::command]` nào**, cùng luật với `src/sql/statements.ts` không import monaco.

Kết quả: `app/setup.rs` là chỗ duy nhất ngoài `app/` biết Tauri tồn tại, và binary test import **0**
DLL giao diện. Đây cũng là điều kiện cần cho cầu stdio ở V2.

**Bước 3 — UI**
- [x] `McpServerSettingsModal.tsx` từ `Modal.tsx`; snippet sinh từ cổng thật (§5.2).
- [x] `audit.rs` + bảng log realtime (§5.3), nhận qua event `mcp-request` chứ không polling.
- [ ] ~~Blocker `closeGuard` ưu tiên thấp (§2.4)~~ — **cố ý bỏ ở V1.** Mọi request V1 đều là ĐỌC, mất
      thì chạy lại được; còn blocker thì cần một chủ sở hữu hộp thoại luôn mounted, tức thêm một
      component thường trực chỉ để cảnh báo về một thứ vô hại. Quay lại khi V2 có ghi.
- [x] Khoá i18n cho toàn bộ chuỗi UI mới (en/vi/ja).
- [x] Phân loại `mcp_*` trong `safeMode.ts` — món nợ từ Bước 2, đã trả.
- [x] Thử thật với ít nhất hai client khác nhau; ghi lại client nào cần đường tương thích nào.

**Bước 3 xong, và ô cuối là ô đắt nhất.** Thử với client thật lộ ra rằng **một snippet không phục vụ
được client nào**: cùng một endpoint streamable HTTP, ba client gọi tên field URL ba kiểu và **bỏ qua
kiểu của nhau mà không báo lỗi**.

| Client | Field | Nếu sai | Đã kiểm |
|:--|:--|:--|:--|
| Claude Code | `"type": "http"` + `url`, hoặc `--transport http` | thiếu `type` → mặc định **stdio**, đi tìm `command` không có | `claude mcp list` → ✔ Connected; `initialize` + 6 `tools/call` chạy qua chính endpoint đó |
| Antigravity | `serverUrl` (`~/.gemini/config/mcp_config.json`) | docs nói rõ `url`/`httpUrl` không hỗ trợ | **chạy thật**: `initialize` → `notifications/initialized` → `list_connections` → `list_tables` |
| Cursor & phần còn lại | `url` trơn | — | chưa (không có client để thử) |

Hai client đã kiểm trả về **cùng một kết quả** trên cùng database (`albums1`, `test`, `test12`,
`test_group`), nên bảng trên là quan sát chứ không phải suy luận từ docs. Một chi tiết phụ nhưng
xác nhận đúng tiền đề của §3.3: `connection_id` hai lần chạy khác nhau (`fc62a1bd…` rồi `a05e7aa9…`)
vì nó được mint mới mỗi lần connect — đó chính là lý do không được khoá chính sách bền theo nó.

Ba cái bẫy nữa, cả ba đều **im lặng**:

1. Claude Code **không** đọc MCP server từ `settings.json` (schema đó `additionalProperties: true`,
   nên khối dán vào đấy được editor nhận và client bỏ qua).
2. `claude mcp add` **không merge** vào tên đã tồn tại, nên sau mỗi lần Regenerate việc phải làm là
   *thay*, không phải *thêm*.
3. Trên Windows, `~/.claude.json` khoá project theo đường dẫn tuyệt đối, và **hai** entry cho cùng
   một thư mục cùng tồn tại, khác nhau đúng ở chữ hoa của ổ đĩa: `c:/workspace/table` và
   `C:/workspace/table`. (`ConvertFrom-Json` còn từ chối parse cả tệp vì coi đó là khoá trùng.)

4. **`Option<T>` để trơn phát `"type": ["string","null"]`, và một `type` dạng MẢNG nằm ngoài schema
   subset Gemini nhận cho function calling.** Nó từ chối cả `tools/list`, nên UI hiện **0 tools** kèm
   một lỗi không liên quan gì tới schema. Sửa: `#[serde(default)]` **cộng** `#[schemars(with = "…")]`
   — cần cả hai, vì `with` cho type scalar còn `serde(default)` là thứ giữ field ngoài `required`
   (thiếu nó thì schema đòi đúng cái tham số vừa được làm optional để cho phép bỏ).

5. **Antigravity cache định nghĩa tool xuống ĐĨA** (`~/.gemini/antigravity-ide/mcp/<server>/`), và
   `Refresh` không fetch lại. Đây là bẫy đắt nhất buổi này: nó làm **năm** thay đổi server liên tiếp
   trở thành vô hình — thông báo lỗi không đổi **một chữ** qua stateful↔stateless, 401↔404, và hai
   hình dạng schema. Dấu hiệu nhận ra: thông báo lỗi bất biến khi server đã đổi. Sửa: xoá thư mục đó
   rồi restart IDE. **Trước khi kết luận bất cứ điều gì về server, kiểm chỗ này.**

6. **HTTP path của MCP client trong Antigravity có thể hỏng độc lập với server.** Log của chính nó, ở
   **mọi** lần khởi động IDE: `mcp_manager.go: Failed to write server states, eagerly loading all
   tools: failed to get server directory`. Nó mở một kênh listen server→client tên
   `subscriptions/listen` và bỏ cả tool list khi kênh đó lỗi, rồi báo ra dưới dạng `session not found`
   với session id **rỗng** — một câu nội bộ, không phản ánh response nào của ta. Đây là điều kiện §7
   đặt ra cho cầu stdio ("chỉ thêm nếu một client mục tiêu thực sự cần"), và nó đã thoả bằng đo. Với
   client này, tab Antigravity trong dialog phát config `--mcp-stdio`, không phát `serverUrl`.

**Hai lần chữa sai đã ghi lại, vì cái giá của chúng là thật.** Đứng trước triệu chứng ở bẫy 5 và 6,
hai thay đổi server đã được thực hiện và **cả hai đều phải revert**: `legacy_session_mode = false`
(stateless bỏ kênh `GET /mcp`, 200 → 405, làm hỏng vĩnh viễn một client đang chạy) và `.well-known`
trả 404 thay vì 401 (đổi handshake auth, trong khi mục tiêu thật chỉ là **dẹp nhiễu trong panel** —
nay đạt bằng cách không ghi audit cho path đó, không chạm status code). Bài học chung: khi thông báo
lỗi của client **không đổi** trong lúc server đã đổi, thủ phạm nằm ở phía client — đừng sửa server
thêm nữa.

   Cơ chế, đã xác lập bằng đo chứ không phải suy luận: **CLI và session runtime resolve khác nhau.**
   `claude mcp add`/`list` canonicalize theo casing thật trên đĩa (`C:/…`) bất kể shell nào gọi —
   nên CLI luôn báo *✔ Connected*. Còn **session** dùng đường dẫn như shell của nó viết ra, và một
   session mở từ Git Bash hay từ IDE ra `c:/…`, trúng entry có `"mcpServers": {}`, nên nạp **0**
   server. Hai triệu chứng của một nguyên nhân, và cái thứ hai là cái tệ: **CLI nói Connected trong
   khi session không có tool nào** — không có đường nào để người dùng tự tìm ra.

   **Cách chữa: `--scope user`.** Nó ghi vào `mcpServers` ở top-level `~/.claude.json`, tức **không
   qua project key nào**, nên cả hai đường resolve đều thấy. Đăng ký `--scope local` hay `project`
   trên máy Windows đều phơi ra bug này. Kiểm bằng `claude mcp remove TABLEGRID -s local` rồi
   `claude mcp add … --scope user`; sau đó cả hai entry project phải còn **0** server và top-level
   phải có nó. Đánh đổi: server (và token) được chào ở mọi project — với một tool dev chạy loopback
   thì đó là giá đúng để trả cho việc tính năng chạy được.

Kết quả: Settings phát **hướng dẫn theo client** (`utils/mcpClients.ts`, ba dáng, khoá bằng
`__tests__/mcpClients.test.ts`) chứ không phát một khối JSON dùng chung; với Claude Code nó phát hai
dòng CLI (`remove` rồi `add`) vì dòng lệnh tự chọn file và tự set transport, tức đóng cả hai bẫy cùng
lúc và chạy lại được. `.mcp.json` cũng đã vào `.gitignore` — nó là lỗ duy nhất còn lại trong khối
"AI Agents", và scope `project` ghi token vào đó.

**Và một món phát sinh, đã làm luôn vì nó là nguyên nhân của ba lượt thử thất bại:** hai cửa HTTP
(layer 1 `Origin`/`Host`, layer 2 token) trước đây **không ghi audit dòng nào** — `deny()` chỉ trả
response, và `Denial` không có biến thể nào cho hai layer đó. Người dùng nhìn bảng Requests thấy "no
request yet" trong khi client bị 401 ở mỗi lần retry, tức hai layer **duy nhất** nổ trong lúc cài đặt
lại là hai layer vô hình — ngược hẳn ý định ghi ở đầu `audit.rs`. Nay `Denial::BadOrigin`/`BadToken`
tồn tại, hai middleware ghi qua `audit::record()` (một người ghi duy nhất, dùng chung với
`tools/mod.rs`), và entry lấy `POST /mcp` làm tên vì chưa có tool nào được parse.

- [x] Server tự bật lại khi mở app (`tf_mcp_autostart`/`tf_mcp_port`, `utils/mcpPrefs.ts`, gọi từ
      `App.tsx`). Không có nó thì tính năng chết sau **mỗi** lần restart app cho tới khi có người vào
      dialog bấm tay — đo bằng chính ba lượt ở trên. Cố ý chỉ lưu bền **công tắc server**, không lưu
      `mcp_exposed`: xem §3.3.

### V2 — ghi có phê duyệt (~2–3 tuần, đánh giá lại sau V1)

- [x] Quyết hợp nhất hay song song với Safe Mode (§3.5) — **trước khi** viết code. Chốt: chung cơ chế, không chung chính sách; xem §3.5.
- [x] Cơ chế park request → event → hộp thoại → channel, có timeout. `mcp/approval.rs` (oneshot theo id, 60s) + `McpApprovalGate.tsx` (hàng đợi, đếm ngược, tự đóng khi hết giờ).
- [x] `tablegrid_mutate` + hộp thoại nói rõ "không nằm trong transaction của bạn". Ba lớp không thay thế nhau: tick ghi (`policy::resolve_write`), một câu lệnh và không phải câu đọc (`ensure_single_write`), rồi hộp thoại. Kiểm lại `reject_if_manual` **sau** khi được duyệt, vì 60 giây là quá đủ để người dùng bật manual-commit.
- [x] Audit log ghi tệp — `mcp/audit_file.rs`, **mã hoá**. Ba điều đáng biết trước khi sửa:
      1. **Mã hoá vì mục ghi mang nguyên văn SQL, mà SQL mang dữ liệu** — một `INSERT` gọi tên giá trị,
         một `WHERE` gọi tên con người. Plaintext trên đĩa biến vết kiểm toán thành bản sao thứ hai
         của dữ liệu, đọc được bởi mọi trình sao lưu / đồng bộ đám mây / lập chỉ mục trên máy.
         AES-256-GCM, khoá 32 byte trong keyring OS cùng chỗ với bearer token (`__mcp__`, field khác).
         `aes-gcm` đã có sẵn trong `Cargo.lock` qua `pkcs5` nên khai báo trực tiếp không thêm crate nào.
      2. **Mỗi dòng buộc vào dòng trước** (tag của dòng trước làm AAD), nên xoá / đảo / chèn dòng làm
         mọi dòng SAU đó không giải mã được. Điều này **không** chống được cắt đuôi tệp — không gì ở
         đây chứng minh được một dòng đã bị xoá từng tồn tại. Nói thẳng thay vì để người đọc tưởng
         tệp chống sửa. Số dòng, kích thước và thời điểm ghi cũng không giấu được.
      3. **Một thread ghi riêng, không phải `spawn_blocking` mỗi mục**: chuỗi buộc dòng làm THỨ TỰ
         ghi thành một phần của định dạng, mà task trên pool thì không có thứ tự. Hot path chỉ
         serialize rồi gửi vào channel; mất mục khi channel hỏng là lựa chọn đúng, vì một nhật ký
         có thể làm nghẽn chính request nó đang ghi sẽ biến sự cố đĩa thành AI client bị treo.
      Đọc lại qua `mcp_audit_file_read` (tab Logs có công tắc *Phiên này* ⇄ *Đã lưu trên đĩa*), và số
      dòng không giải mã được hiện ra cạnh danh sách chứ không bị nuốt — một log lặng lẽ ngắn đi tệ
      hơn không có log.
- [x] Cầu stdio: một proxy mỏng stdio↔HTTP loopback, cờ xử lý **trước** `tauri::Builder` — **không**
      cần plugin single-instance. §0.4 lo đúng một nửa: nó đúng rằng mở app thứ hai là sai, nhưng mode
      proxy **không bao giờ chạm tầng cửa sổ** (`mcp/stdio.rs::serve()` không quay lại `run()`), nên
      không có hai instance nào tranh nhau. Toàn bộ phần bootstrap là **một `if`** ở đầu `app/run.rs`.
      Làm sớm hơn V2 vì có điều kiện thật — xem Bước 3 bên dưới, bẫy thứ sáu.

---

## 7. Đã cân nhắc và KHÔNG làm

- **Endpoint `/sse` như transport chính** — bản cũ của spec (§2.3). Chỉ thêm nếu một client mục tiêu
  thực sự cần, và khi đó nó là đường tương thích.
- ~~**`TABLEGRID.exe --mcp` ở V1**~~ — **đã làm**, dưới tên `--mcp-stdio` (`mcp/stdio.rs`). Ước lượng
  "ba thay đổi ở tầng bootstrap" hoá ra là **một `if`**: single-instance không cần, vì proxy không
  chạm tầng cửa sổ. Nó cũng mang hai món lợi ngoài dự tính — config của client chỉ còn `command` +
  `args` (đường dẫn exe mà dialog tự biết, nên **máy khác không phải sửa tay**), và **không còn token
  trong config client** vì proxy tự đọc keyring.
- **Tool Redis** — 40+ command với mô hình quyền riêng. Sau V1, nếu có nhu cầu thật.
- **Truy vấn liên-kết-nối** — cùng lý do `multi-connection-plan.md` đã loại: không có engine nào để
  join hai kết nối, và giả vờ có là hứa sai với AI.
- **MCP Resources / Prompts** — Tools đã phủ hết use case; thêm hai khái niệm nữa là thêm bề mặt mà
  chưa có ai xin.
- **OAuth cho MCP** — dành cho server từ xa. Bearer token trên loopback là đúng tầm mối đe dọa, và
  là thứ các client hiện hỗ trợ qua `headers`.
- **Nhét `LIMIT` vào SQL của AI** — §4.3.
- **Cho MCP đi qua `#[tauri::command]`** — chúng cần `tauri::State`; §2.1.
- **Tự viết tầng JSON-RPC / Streamable HTTP** — §2.3. Spec đã đi qua ít nhất hai revision kể từ bản
  mà tài liệu này ban đầu nhắm tới, và thoả thuận version viết tay là chỗ sai lặng lẽ. `rmcp` là crate
  chính thức, và độ khớp phụ thuộc với cây hiện có gần như tuyệt đối.

---

## 8. Rủi ro còn mở

- **Một AI client cấu hình sai có thể quét cả database.** Timeout + giới hạn dòng hãm được tác động,
  không hãm được số lượng lời gọi. Nếu thành vấn đề: rate limit trong `policy.rs`, đo trước rồi làm.
- **Token nằm trong file cấu hình của AI client** (`.cursor/mcp.json` và tương đương) — thường là
  plaintext, và có khi bị commit vào repo. Settings nói thẳng điều này cạnh nút Copy, và `.mcp.json`
  đã vào `.gitignore`. **Đóng cho đường `--mcp-stdio`**: config đó chỉ có `command` + `args`, proxy tự
  đọc keyring, nên không có token nào để rò. Vẫn mở cho hai đường HTTP, và đó là lý do thứ hai để
  ưu tiên stdio ở client nào cũng dùng được nó.
- ~~**`exposed` là per-`conn_id` trong Rust nhưng bền theo `connKey` ở frontend.**~~ — **đã đóng**
  bằng cách không lưu bền nó: xem §3.3. Không còn nơi thứ hai thì không còn chỗ lệch.

- **Phơi một kết nối là phơi tầm-với mức SERVER, không phải mức database.** (Dialog nay **đo và kể tên** những database mà mỗi tick với tới được — `listDatabases(connId)`, cùng truy vấn mà AI chạy được — thay cho một câu cảnh báo trừu tượng. Đó là cách duy nhất app có thể nói đúng về chuyện này: không suy từ grant, mà báo cái đang thật.) `TABLEGRID_query` phân
  loại **chỉ theo đầu câu lệnh** (`ensure_single_read`), không giới hạn bảng hay database, nên trên
  một kết nối đã phơi thì `SELECT … FROM information_schema.tables` và `SHOW DATABASES` liệt kê cả
  server, còn `SELECT * FROM db_khac.bang` (MySQL) / `schema_khac.t` (Postgres) **đọc được dữ liệu
  thật** từ database chưa bao giờ được tick. `TABLEGRID_list_databases` vốn đã trả về mọi database
  của server, nên độ hạt thật của việc phơi luôn là server — §3.3 chỉ bảo vệ *danh tính kết nối*,
  không bảo vệ *tầm với dữ liệu*.
  Cách vá hiển nhiên — chặn chuỗi `information_schema`/`pg_catalog`/tên database — là **đúng cơ chế
  §0.3 đã bác**: nó vừa lọt (`INFORMATION_SCHEMA`, alias trong subquery, cross-schema) vừa tạo cảm
  giác an toàn sai. Biên giới hữu hiệu duy nhất là **grant**: một DB user chỉ đọc, chỉ có quyền trên
  database được phơi. Settings nay nói thẳng điều này cạnh danh sách tick, thay cho câu cũ ("*sharing
  is per connection, not per server*") vốn phát biểu ngược lại sự thật. Cưỡng chế ở mức database
  trong app là việc của V2, nếu có nhu cầu thật.

- ~~**`statement_timeout` là opt-in, nên "timeout đã là cái hãm" (§4.4) không phải bảo đảm.**~~ —
  **đã đóng** bằng `policy::mcp_timeout()`: min(giới hạn người dùng, 30s), và `Target::timeout` không
  còn là `Option`. Xem §4.4.

- ~~**Introspection không đi qua trần đó.**~~ — **đã đóng.** Ba tool ở `catalog.rs` giờ bọc
  `with_timeout(Some(target.timeout), …)` như `data.rs`, nên MCP không còn đường nào chạy không hạn
  giờ. Lý lẽ để mở ("truy vấn catalog bị chặn bởi bản chất chứ không bởi dữ liệu") đúng cho tới khi
  một server có hàng nghìn bảng làm nó sai, mà giá để đóng chỉ là một wrapper mỗi thân hàm.
- **`describe_table` phơi tên cột của schema production cho một dịch vụ bên ngoài.** Đó là bản chất
  của tính năng, không phải lỗi — nhưng nó là lý do §3.3 mặc định TẮT và không có nút "phơi tất cả".
- **`rmcp` đang ở nhịp phát hành dày** (5 bản trong ~3 tuần lúc khảo sát, major 3.x). Pin `3.1` hãm
  được, nhưng một thay đổi API ở bản major sau là việc phải làm lại. Đổi lại: tự viết thì mỗi lần
  spec đổi cũng là làm lại, mà lại không có ai báo cho biết.
