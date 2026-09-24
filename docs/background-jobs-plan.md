# Kế hoạch: chạy Export / Generate Data / Import-Restore / Backup ở chế độ nền (background jobs)

> Trạng thái: **Phase 0–4 đã code** (xem §5). Phase 3 mới phủ SQL dump; XLSX/JSON/CSV vẫn dựng trong RAM.

## 1. Triệu chứng

Bốn thao tác dài nhất của app — xuất dump, sinh dữ liệu test, nhập/phục hồi dump, sao lưu — đều
giữ app làm con tin cho tới khi xong:

- Dialog là modal, và tiến độ **thuộc về dialog**. Đóng dialog là mất tiến độ, mất luôn kết quả.
  Nên trong 20 phút restore sakila, người dùng chỉ ngồi nhìn.
- Không xem được bảng khác, không chạy được query khác, không mở được kết nối khác.
- Restore **không huỷ được**: bấm sai tệp là phải chờ hết, hoặc kill app và nhận một database
  nạp được một nửa.
- Không có chỗ nào trả lời được câu "bản backup tối qua chạy xong chưa, có lỗi gì không".

## 2. Hiện trạng bốn thao tác

| Thao tác | Vòng lặp chạy ở đâu | Tiến độ | Huỷ | Kết nối |
|---|---|---|---|---|
| Export DB / Backup (SQL dump) | **Frontend** — `buildDump` ([dumpBuilder.ts](../src/utils/dumpBuilder.ts)), N lần `invoke` mỗi bảng | callback `onProgress` → state của dialog | ❌ | connId của workspace |
| Export DB (XLSX/JSON/CSV) | **Frontend** — `handleExportDatabase` ([App.tsx:461](../src/App.tsx#L461)) | state của dialog | ❌ | connId của workspace |
| Export một bảng | **Frontend** — vòng lặp trang trong `ExportTableDialog` | state của dialog | ❌ | connId của workspace |
| Import / Restore | **Rust** — `restore_backup` ([database.rs:2779](../src-tauri/src/database.rs#L2779)) | `Channel`, throttle 20 câu/lần (`PROGRESS_EVERY`) | ❌ | connId của workspace |
| Generate Data | **Rust** — `generate_data` | `Channel` | ✅ `cancel_flags[cancel_key(conn_id)]` | connId của workspace |
| Redis transfer | **Frontend** — batch 200 key | state của dialog + `useRef` stop | ✅ (chỉ trong lúc dialog mở) | connId của workspace |

Hai họ khác nhau về bản chất:

- **Họ A (Rust)** — `restore_backup`, `generate_data`. Bản thân đã async và đã có kênh tiến độ;
  cái thiếu **chỉ là ở UI** (ai giữ kênh) và cờ huỷ cho restore.
- **Họ B (Frontend)** — dump, export bảng, redis transfer. Vòng lặp chạy trên main thread, và cả
  artifact nằm trong RAM dưới dạng một chuỗi JS trước khi ghi ra đĩa.

## 3. Nguyên nhân — năm giả định "một thao tác chiếm cả app"

### 3.1 Tiến độ thuộc dialog
`setProgress` là state của component. Component unmount là mất. Đây là lý do các dialog buộc phải
modal và buộc phải mở suốt.

### 3.2 Cả artifact nằm trong RAM
`buildDump` trả về **một chuỗi**, rồi `gzipText` nén cả chuỗi đó, rồi `saveExportFile` ghi một lần
([fileSave.ts:225](../src/utils/fileSave.ts#L225)). Đỉnh bộ nhớ ≈ 2–3× kích thước dump; dump 2 GB là
không thể, mà không có lỗi nào nói ra điều đó cho tới khi tab webview chết.

### 3.3 Vòng lặp họ B chạy trên main thread
Phần `await invoke(...)` thì nhường event loop, nhưng phần `JSON.parse` mỗi trang và phần nối chuỗi
thì không. UI đứng theo từng nhịp kể cả khi không còn modal.

### 3.4 Job dùng chung kết nối của người dùng
Đây là chỗ nguy hiểm nhất, và nó không hiện ra thành lỗi rõ ràng:

- `should_route()` ([tx_session.rs](../src-tauri/src/tx_session.rs)) route **theo kết nối**. Job
  chạy trên connId của người dùng, mà người dùng đang bật manual transaction → câu SQL người dùng
  gõ **nhập vào transaction của job**, hoặc ngược lại.
- Trạng thái session bị dùng chung: `SET FOREIGN_KEY_CHECKS = 0`, `PRAGMA foreign_keys OFF`,
  `SET CONSTRAINTS DEFERRED`, statement timeout. Restore đang tắt FK check trên đúng kết nối mà
  người dùng đang browse bằng.
- `restore_backup` và `generate_data` **từ chối chạy** khi manual mode đang bật — đúng theo thiết
  kế hiện tại, nhưng với kết nối riêng thì lý do từ chối biến mất.
- `cancel_flags` khoá theo `conn_id`, nên hai job trên cùng một kết nối sẽ huỷ lẫn nhau.

### 3.5 Restore không có cờ huỷ
`generate_data` đã có (`cancel_data_generation`), `execute_query_stream` đã có (`cancel_query`),
`restore_backup` thì không — dù nó là cái chạy lâu nhất trong app.

## 4. Quyết định phải chốt TRƯỚC khi code

### 4.1 Job store là module-level, KHÔNG phải React context/state của `App`

Theo đúng hình mẫu đã có trong repo: `utils/queryHistory.ts` và `utils/safeMode.ts` giữ state ngoài
React rồi phát `CustomEvent`; `tx_session.rs` đẩy `tx-state-changed` thay vì thêm field vào mọi
response.

Hai lý do, cả hai đều là lý do kỹ thuật chứ không phải thẩm mỹ:

1. Job phải sống lâu hơn mọi dialog — mà dialog thì bị unmount theo thiết kế.
2. Nếu tiến độ nằm trong state của `App`, mỗi tin nhắn tiến độ re-render **mọi tab**. Đây chính là
   thứ mà debounce 150ms của `SqlEditor` được thêm vào để tránh; đừng dựng lại nó ở chỗ khác.

Store phải **coalesce** tiến độ (≤ 5 lần/giây) trước khi gọi subscriber. Họ A đã throttle bên Rust
(`PROGRESS_EVERY = 20`), họ B thì báo theo bảng/trang nên cũng cần chốt ở một chỗ chung.

Bản ghi một job:

```ts
{ id, kind: 'dump'|'restore'|'generate'|'export-table'|'redis-transfer',
  title, target: { connKey, db, schema }, jobConnId,
  state: 'queued'|'running'|'done'|'error'|'cancelled',
  progress: { label, current, total, detail } | null,
  startedAt, endedAt, result?: { path, statements, failed, rows }, error?, cancel(): void }
```

### 4.2 Mỗi job có KẾT NỐI RIÊNG, đánh dấu `purpose: 'job'` trong registry

Multi-connection đã xong (`multi-connection-plan.md` Phase 3), nên đây là việc làm được ngay, và nó
xoá luôn cả §3.4:

- Job tự mint connId của nó. Config **không** đi vòng qua frontend: thêm lệnh dạng
  `open_job_connection(source_conn_id)` clone `last_config` ở backend — đúng nguyên tắc §4.3 của
  plan kia ("id do backend mint, không bao giờ suy ra từ config vì config mang credential"), và
  cũng đúng cách `db_compare.rs::resolve_side()` đang mở pool ngắn hạn.
- Registry có thêm `purpose`. Rail, quick-switcher và picker database **bỏ qua** kết nối `job` —
  nếu không, người dùng thấy một kết nối lạ tự mọc ra rồi tự mất đi.
- Hệ quả tốt: guard "manual mode đang bật thì không cho restore/generate" trở thành đúng theo từng
  kết nối, tức là người dùng có transaction mở ở tab của họ **vẫn** chạy được restore ở nền.
- Hệ quả phải nói ra: job có thể **chờ khoá** do transaction của chính người dùng đang giữ. Phải
  hiện được "đang chờ lock" chứ không treo im ở 40%.
- SSH tunnel / IAM: job tự connect nên tự sở hữu tunnel của nó (drop handle là đóng port — xem
  `ssh_tunnel.rs`). Task refresh token IAM đang skip khi có transaction mở; phải skip thêm khi có
  job đang chạy trên pool đó.
- SQLite: xem Phụ lục A.

### 4.3 KHÔNG viết lại `dumpBuilder` sang Rust

`export_multi_tables` bên Rust đã bị xoá vì đúng lý do này: nó coi view là bảng, ghi một INSERT mỗi
dòng, không có routine/trigger, và mọi bản sửa cho dialog đều không chạm tới đường Backup. Repo này
đã có ba cặp "twin phải sync tay" (`split_sql_statements` ↔ `sql/statements.ts`, literal lỗi Rust ↔
`backendErrors.ts`, `redis_ssl_mode` ↔ `REDIS_SSL_MODES`) và mỗi cặp đều có giá. Không thêm cặp thứ
tư cho thứ vừa mới hợp nhất xong.

Việc cần làm với họ B chỉ là **đưa vòng lặp ra khỏi React**: `buildDump` đã nhận `reader` bằng
injection và đã có `onProgress` — nó vốn không cần React. Job runner gọi nó, dialog chỉ vẽ.

### 4.4 Safe Mode hỏi MỘT lần lúc submit; job không được hỏi giữa đường

`runApproved()` đã đúng hình dạng cần (hỏi một lần, giữ cửa mở suốt lần chạy, đóng trong `finally`,
đếm theo độ sâu). Ba điều chỉnh:

1. Hỏi lúc **submit**, trên kết nối/server người dùng đang thấy (Safe Mode lưu theo `connKey`, tức
   theo **server**, nên connId của job chưa tồn tại cũng không sao).
2. Cửa phải mang **job id**: cửa của job này không được cho lệnh của job khác đi qua.
3. Nếu cửa không mở, job **fail ngay với thông báo rõ**, không được bật dialog giữa lúc chạy nền —
   một câu hỏi không ai nhìn thấy sẽ treo job ở 40% im lặng.

### 4.5 Một job GHI cho mỗi database; job ĐỌC tối đa 2–3

Hai lần restore vào cùng một database không bao giờ là ý người dùng muốn. Registry từ chối và **nói
lý do**. Job đọc (export) chạy song song được, nhưng cap 2–3 để không hút cạn pool. Quá cap thì
`queued`, FIFO, không ưu tiên gì.

### 4.6 Job KHÔNG sống qua lần reload — nên phải chặn đóng cửa sổ

Họ B chết theo webview; họ A là tokio task, sống tiếp nhưng không còn ai giữ `Channel` → tiến độ và
kết quả mất. Vì vậy:

- Mở rộng guard `onCloseRequested` đã có trong [TxControl.tsx:88](../src/components/TxControl.tsx#L88):
  còn job đang chạy thì hỏi trước khi đóng. Một restore bị kill giữa đường để lại database nạp dở.
- Dev mode: HMR reload webview → job họ A thành mồ côi. Ghi nhận là wart của dev, không chữa ở v1.
- Resume sau khi restart app: **ngoài phạm vi** (xem Phụ lục B).

### 4.7 Ghi ra file theo dòng chảy (sink), thay vì trả về một chuỗi

Đổi `buildDump` từ "trả về string" sang "nhận `onChunk(text)`", và thêm ba lệnh Rust nhỏ:
`export_open(path, gzip) -> handle`, `export_append(handle, chunk)`, `export_close(handle)` — nén
gzip tăng dần bên Rust (`export.rs` đã có helper gzip).

Test hiện tại không phải viết lại: `dumpBuilder.test.ts` gom các chunk rồi `join('')`, nên mọi
assertion về **thứ tự câu lệnh** (thứ tự đang load-bearing: sequence → table → data → FK deferred →
setval → view → routine → trigger) giữ nguyên nghĩa.

## 5. Việc cần làm

Mỗi phase ship được độc lập, và Phase 0 đã lấy được phần lớn giá trị.

### Phase 0 — job store + tray + guard đóng cửa sổ *(không đổi cách thực thi)* — ✅ ĐÃ CODE
1. ✅ [`src/utils/jobs.ts`](../src/utils/jobs.ts): store module-level, bản ghi **immutable** (không
   thì `useSyncExternalStore` thấy cùng một tham chiếu và tray đứng im), coalesce tiến độ 150ms,
   hàng đợi + cap 3, độc quyền theo database khi có job GHI, huỷ. Test: `__tests__/jobs.test.ts`.
2. ✅ [`components/JobsTray.tsx`](../src/components/JobsTray.tsx): một **nút chuông** trên thanh
   tiêu đề (badge = số việc đang chạy), mở một **popover neo ngay dưới nút** — không phải hộp thoại
   giữa màn hình: việc chạy nền là thông báo, và xem nó không được che thứ đang làm. Trong popover:
   progress bar, huỷ, "mở thư mục", text lỗi, xoá việc đã xong. `.jobs-pop` dùng CHUNG rule với `.sm-pop`
   của Safe Mode bằng một selector ghép trong `index.css` (không phải bản sao), nên dáng popover của
   thanh tiêu đề sửa một chỗ là cả hai đổi theo. Không có job nào thì nút **không hiện** — thanh
   tiêu đề giữ nguyên như trước tới lần chạy đầu tiên.
3. ✅ Bốn luồng nặng chuyển sang submit-and-forget: Export Database, Import Database
   (`App.tsx`), Backup/Restore của Connection Manager, Data Generator. Ba cái đầu đóng dialog ngay;
   Data Generator vẫn vẽ progress của riêng nó **khi còn mở** (cùng một lần chạy, không phải hai)
   và đóng lúc nào cũng được.
4. ✅ [`utils/closeGuard.ts`](../src/utils/closeGuard.ts): **một** listener `onCloseRequested` cho
   cả app + danh sách blocker theo ưu tiên (transaction chưa commit trước, job đang chạy sau). Hai
   listener độc lập không dùng được: cái nào resolve trước sẽ `destroy()` và giết hộp thoại của cái
   kia. `TxControl` đổi sang blocker, không tự đăng ký listener nữa.
5. ✅ Ba lệnh dài nhận `connId` **tường minh** (`restoreBackup`, `generateData`,
   `cancelDataGeneration`), và `getAllTriggers`/`getTableDdlExtras` cũng vậy: một job có thể nằm
   trong hàng đợi, tới lượt nó thì `currentConnId` (ambient) đã là kết nối khác — tức là restore
   vào đúng database người dùng không chọn. `withConnId()` trong `dbHelper` là chỗ duy nhất biết
   luật "chỉ đặt khoá khi có giá trị thật" (một `connId: undefined` tường minh sẽ ghi đè ambient).
6. ✅ `utils/restoreProgress.ts`: nhãn + ETA của restore tính ở một chỗ, vì hai màn hình cùng chạy
   restore (Import Database và Connection Manager) và cả hai giờ đều là job.

**Còn lại của Phase 0** (làm sau, và biết vì sao chưa làm):
- Export **một bảng** (`ExportTableDialog`) và **Redis transfer** vẫn chạy trong dialog. Cả hai đều
  ngắn hơn hẳn (một bảng, hoặc một tiền tố key) và Redis transfer đã có nút Stop riêng; đổi chúng
  kéo theo bỏ `done`/`onSuccess` của dialog và sửa cả chuỗi prop ở `App.tsx`/`DataGrid`/`Sidebar`.
- ~~Connection Manager: `connect()` đổi ambient `currentConnId` trong lúc chạy~~ — xoá ở Phase 1
  (`connectJob`).
- ~~Safe Mode vẫn hỏi mỗi lệnh trong một job~~ — xoá ở Phase 1 (`approveJob` + `openJobDoor`).

### Phase 1 — kết nối riêng cho job — ✅ ĐÃ CODE
- `ConnEntry.purpose: ConnPurpose { User, Job }` — field bắt buộc, nên compiler chỉ ra mọi chỗ dựng
  entry. `list()` (rail), `handles()` (ping), `find()` và `find_sqlite()` bỏ qua `Job`.
- `open_job_connection(conn_id)` **dùng chung pool** của kết nối nguồn thay vì dựng pool mới (khác
  với §4.2 ở trên): không phải xác thực lại, tunnel SSH/IAM vẫn là của `Arc<ServerHandle>` dùng chung,
  và job vẫn chạy tiếp nếu người dùng ngắt kết nối nguồn giữa chừng (một clone của pool giữ pool
  sống). Thứ cần tách là `conn_id` — session transaction, cờ huỷ, guard manual-mode đều khoá theo nó —
  chứ không phải socket: session-level state nằm trên từng connection của pool, và mọi job có đặt
  state đều tự `acquire` một connection rồi trả về sạch. SQLite không có pool nên mở **handle thứ
  hai** trên tệp, `busy_timeout` 30s (Phụ lục A). `close_job_connection` chỉ đóng entry `Job`.
- `connect_db(job: true)` cho Backup/Restore của Connection Manager (mở từ form, không có kết nối
  nguồn): không đổi ambient `currentConnId` nữa — xoá luôn khe hẹp ghi ở "Còn lại của Phase 0" — và
  không dedupe SQLite lên kết nối của người dùng (trước đây `finally` của job có thể đóng đúng kết
  nối người dùng đang mở trên cùng tệp).
- Frontend: `utils/jobConnection.ts` (`withJobConnection` / `runOnJobConnection`) là đường DUY NHẤT;
  Export, Import, Copy, Backup/Restore và Data Generator đều đi qua nó.
- Safe Mode: `approveJob` / `approveJobForServer` hỏi **lúc submit**, `openJobDoor` mở cửa cho đúng
  lệnh đó trên đúng `conn_id` của job (id đó chỉ job này dùng). Từ chối thì job không được xếp hàng.
- `USE <db>` trong dump giờ chỉ đổi database của kết nối job, không đổi kết nối người dùng đang xem;
  kết quả job nói dữ liệu đã vào database nào.

### Phase 2 — huỷ được restore — ✅ ĐÃ CODE
`cancel_restore(conn_id)` + cờ `__restore__:<conn_id>` trong `cancel_flags`, gỡ bằng một guard `Drop`
nên mọi lối ra (kể cả `?`) đều dọn. Kiểm cờ giữa hai câu lệnh, `ROLLBACK`, trả `cancelled: true` kèm
số câu đã chạy; tray nói thẳng rằng trên MySQL các DDL đã chạy vẫn còn (implicit commit).

Kèm một bug thật tìm ra khi làm phase này: nhánh Postgres của `restore_backup` gửi `BEGIN` và từng câu
qua `execute_raw_sql_generic` (mỗi lần một connection của pool). Transaction chỉ dính lại được vì
`should_route` thấy `BEGIN` và **mở session transaction thủ công trên conn_id của người dùng** — nên
bộ đếm pending đếm từng INSERT của restore, và câu người dùng gõ trong lúc đó chui vào transaction của
restore. `SET CONSTRAINTS ALL DEFERRED` thì chạy trước `BEGIN` trên một connection khác, tức vô tác
dụng. Giờ nhánh Postgres giữ **một** connection như nhánh MySQL, dùng `raw_sql`, và bọc savepoint
quanh cả các câu session-level (một `SET` bị từ chối từng đầu độc cả transaction, 25P02). SQLite cũng
không đi qua funnel nữa.

### Phase 3 — sink ghi file cho họ B — ✅ ĐÃ CODE (phần SQL dump)
- Rust `export_sink.rs`: `export_open(path, gzip)` / `export_append` / `export_close` /
  `export_abort`. Ghi vào `<path>.part`, chỉ đổi tên sang tên thật khi `close` — job lỗi hoặc bị huỷ
  không để lại một tệp trông như backup hoàn chỉnh, và backup cũ chỉ bị thay khi bản mới đã đủ. Nén
  gzip tăng dần bằng `flate2` (`CompressionStream` của webview cần cả input trong một `Blob`, đúng thứ
  đang bỏ). I/O chạy trên `spawn_blocking`.
- `dumpBuilder.ts`: `writeDump(spec, reader, emit)` đẩy dump ra theo từng đoạn, mỗi đoạn kết thúc
  giữa hai câu lệnh — header, mỗi bảng, **mỗi TRANG dữ liệu** (`readTablePages`), rồi constraints/view/
  routine. `buildDump` giờ chỉ gom các đoạn lại và trả về đúng từng byte như trước, nên mọi test thứ
  tự vẫn giữ nghĩa. `EXPORT_PAGE_SIZE` (2000) là bội của số dòng mỗi INSERT (500) nên câu lệnh ra y hệt.
- `fileSave.ts`: `openFileSink` (gom ~1M ký tự mỗi lần IPC) và `saveDumpToFolder` — không có thư mục
  hoặc không tạo được tệp thì quay về đường cũ trong RAM, nên một thư mục không ghi được chỉ tốn bộ
  nhớ chứ không mất bản xuất.
- Dùng bởi Export Database (SQL) và Backup của Connection Manager.
- **Chưa** stream: XLSX/JSON/CSV của Export Database và Export một bảng (XLSX cần cả workbook; hai
  định dạng kia có thể làm theo cùng khuôn nếu cần), và Copy database (restore nhận cả chuỗi dump).

### Phase 4 — lịch sử job — ✅ ĐÃ CODE
`utils/jobHistory.ts`: `settle()` của `jobs.ts` ghi một bản ghi nhỏ (`tf_job_history`, 50 mục, text
cắt ở 600 ký tự, hết quota thì giữ nửa mới nhất) cho mọi job ĐÃ CHẠY — job huỷ khi còn trong hàng đợi
không được ghi. Tray có mục "Trước đó" và nút chuông vẫn hiện khi chỉ còn lịch sử, vì câu "backup tối
qua xong chưa" được hỏi đúng lúc không có gì đang chạy. Chưa lọc theo scope — tiêu đề job đã mang tên
database.

**OS notification — ✅ ĐÃ CODE.** Lệnh `notify_os` (`app/notify.rs`) dùng thẳng `notify-rust`. Bản đầu
dùng `tauri-plugin-notification` 2.4 và **không hiện gì trong dev**: plugin chọn AppUserModelID theo
đường dẫn exe, `CARGO_TARGET_DIR` của repo làm nó tưởng là bản cài đặt, dùng ID chưa đăng ký, và
Windows bỏ thông báo mà không báo lỗi (plugin còn nuốt lỗi). `utils/jobNotify.ts`: một job **xong hoặc lỗi**
khi cửa sổ KHÔNG được focus (`document.hidden || !document.hasFocus()`) thì bật thông báo; đang nhìn app
thì không (tray đã đủ), huỷ thì không (người dùng tự bấm). Nghe qua `onJobSettled` của `jobs.ts`, đăng
ký trong `JobsTray`; công tắc + nút "Gửi thử" ở cuối popover (`tf_job_notify`, mặc định bật). Trên
Windows ở chế độ dev, thông báo hiện dưới tên "Windows PowerShell" — bản cài đặt mới mang tên app (AUMID
do installer đăng ký).

## 6. Ước lượng & rủi ro

| Phase | Ước lượng | Rủi ro chính |
|---|---|---|
| 0 | trung bình | Nhiều điểm sửa ở UI, nhưng không đụng logic DB → rủi ro thấp nhất, giá trị cao nhất |
| 1 | trung bình | Sai chỗ nào là job dùng nhầm kết nối của người dùng → quay lại đúng bug đang có. Cần compiler bắt: `purpose` là field bắt buộc, không phải `Option` |
| 2 | nhỏ | Rollback khi huỷ giữa MySQL DDL vẫn không nguyên tử (implicit commit) — phải nói thẳng trong UI, đừng hứa "đã hoàn tác sạch" |
| 3 | trung bình–lớn | Chunk cắt sai chỗ làm hỏng dump. Chỉ cắt **giữa hai câu lệnh**, không cắt giữa một INSERT |
| 4 | nhỏ | Quota localStorage — đã có tiền lệ và cách xử lý ở `tabsStorageKey` |

## 7. Verification

- Thử tay: bắt đầu restore sakila → đóng dialog → mở tab khác, chạy query, đổi kết nối → tray vẫn
  đếm; huỷ giữa đường; thử đóng app khi đang chạy.
- Job trên kết nối riêng: bật manual transaction ở tab người dùng, chạy generate data → không bị từ
  chối, và counter pending của người dùng **không** nhúc nhích.
- Unit test được (thuần, không monaco/tauri): reducer của `jobs.ts` (chuyển trạng thái, coalesce,
  cap song song, hàng đợi) và `buildDump` với sink (gom chunk → join → so với snapshot cũ).
- Không test được bằng unit: `Channel`, `onCloseRequested`, tray → kiểm tay.

## Phụ lục A: SQLite — hai handle trên một tệp

`DbConnection::Sqlite` là **một** handle dùng chung; mở connId thứ hai cho job là mở handle thứ hai
trên cùng tệp → tranh khoá ghi (`SQLITE_BUSY`), vì SQLite khoá theo tệp chứ không theo kết nối.

Đề xuất: vẫn mở handle riêng, kèm `busy_timeout` (~5s) ở cả hai và WAL nếu tệp cho phép. Được thêm
một thứ: `PRAGMA foreign_keys OFF` của restore nằm trên handle của job, không còn tắt FK check trên
handle mà người dùng đang browse. Đổi lại phải chấp nhận job ghi và người dùng ghi thì tuần tự hoá —
đúng bản chất SQLite, và thà chờ có báo còn hơn lỗi `SQLITE_BUSY` bật lên giữa lúc gõ.

## Phụ lục B: đã cân nhắc và KHÔNG làm

- **Web Worker cho việc dựng dump.** `@tauri-apps/api` cần `window.__TAURI_INTERNALS__`, không có
  trong worker → mọi lần đọc DB phải proxy qua main thread, mà đó chính là chỗ tốn thời gian. Phức
  tạp thêm mà không được gì.
- **Viết lại `dumpBuilder` sang Rust.** §4.3.
- **Resume một job sau khi restart app.** Một restore dở không resume được một cách trung thực: phải
  biết đã chạy tới câu nào *và* server đã commit tới đâu, mà MySQL thì implicit commit trên DDL. Thà
  không hứa. Cái đáng làm là ghi lại **kết quả** (Phase 4), không phải resume.
- **Job chạy theo lịch (cron backup).** Là feature khác, và cần app đang mở mới có nghĩa.
- **Một tab riêng cho job thay vì tray.** Job không phải nội dung để đọc lâu; tray + dialog đủ, và
  tab thì tranh chỗ với tab dữ liệu.
- **`active_job` ở backend.** Cùng lý do plan kia bỏ `active_conn_id`: một giá trị ambient ở backend
  là race ngay khi có job thứ hai. Job id do frontend tạo, connId do backend mint.
