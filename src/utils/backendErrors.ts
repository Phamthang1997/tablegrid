/**
 * Translates the error text returned by the Rust backend into the active UI language.
 *
 * WHY THIS EXISTS AS A TABLE
 * The Tauri commands in `src-tauri/src/*.rs` return `Result<_, String>` with a
 * human-readable Vietnamese message, and the frontend surfaces that message verbatim.
 * Rather than change the shape of every `Err(...)` in the backend, the boundary maps
 * those messages to translation keys here.
 *
 * The strings below are matched as **protocol constants**, not as user-facing prose:
 * they are produced by Rust in one fixed language and never vary with the UI language,
 * so matching on them is not the "branch on user-facing text" mistake. They are the
 * twin of the Rust literals in the same way `src/sql/statements.ts` is the twin of
 * `split_sql_statements` — **if you reword a message in Rust, update it here too**.
 *
 * Anything that does not match falls through unchanged, so a missed or reworded
 * message degrades to today's behaviour (raw backend text) instead of being lost.
 */

import i18n from '../i18n';

/** Backend messages with no interpolation — matched whole, after trimming. */
export const EXACT: Record<string, string> = {
  'Chưa kết nối CSDL': 'backend.notConnected',
  'Kết nối đang ở chế độ chỉ đọc — tắt chế độ này trước khi ghi': 'backend.connReadOnly',
  // oauth.rs — the client id is baked in at compile time and may be empty
  'Chưa cấu hình Google OAuth client id cho bản dựng này': 'backend.oauthClientMissing',
  // mcp/approval.rs — the only Vietnamese string in mcp/, because it answers the APPROVAL DIALOG
  // rather than an AI client (everything the client reads stays English, see mcp/mod.rs).
  'Yêu cầu này không còn chờ trả lời (đã hết hạn hoặc đã được trả lời).': 'backend.mcpApprovalGone',
  // state/registry.rs — the write tick refuses on a connection that is not shared.
  'Kết nối này chưa được chia sẻ với MCP nên không thể bật quyền ghi': 'backend.mcpWriteNeedsShare',
  // tx_session.rs — transaction manual
  'Không có transaction nào đang mở': 'backend.txNotOpen',
  'Transaction đã bị huỷ do lỗi trước đó, chỉ có thể rollback': 'backend.txAborted',
  'Transaction đang mở — hãy commit hoặc rollback trước khi bật lại auto-commit': 'backend.txPendingAutocommit',
  'Mức cô lập không hợp lệ cho hệ quản trị này': 'backend.txBadIsolation',
  'Phiên transaction không sẵn sàng': 'backend.txSessionNotReady',
  // The three below are COMPLETE messages rather than assembled ones: a translatable frame with a
  // Vietnamese tail interpolated into it would show half English, half Vietnamese in the EN/JA UI.
  'Transaction đang mở — hãy commit hoặc rollback trước khi đổi database': 'backend.txOpenSwitchDb',
  'Đang bật commit thủ công — hãy kết thúc transaction và chuyển về tự động trước khi phục hồi dữ liệu':
    'backend.txOpenRestore',
  'Đang bật commit thủ công — hãy kết thúc transaction và chuyển về tự động trước khi sinh dữ liệu':
    'backend.txOpenGenerate',
  'Kết nối không khớp với phiên transaction': 'backend.txConnMismatch',
  'Tên savepoint chỉ gồm chữ, số và dấu gạch dưới, bắt đầu bằng chữ': 'backend.txBadSavepointName',
  'Chưa kết nối database': 'backend.notConnected',
  'Chưa kết nối Redis': 'backend.notConnectedRedis',
  'Chưa có cấu hình kết nối': 'backend.noConnConfig',
  'Chưa có cấu hình kết nối để quét sâu': 'backend.noConnConfigDeepScan',
  'Hệ quản trị CSDL không được hỗ trợ': 'backend.unsupportedDbms',
  'Dữ liệu import không có cột nào': 'backend.importNoColumns',
  'Không có dữ liệu để tạo bảng': 'backend.noDataForTable',
  'Không lấy được định nghĩa đối tượng': 'backend.noObjectDefinition',
  'Không tìm thấy định nghĩa': 'backend.definitionNotFound',
  'Không tìm thấy định nghĩa bảng': 'backend.tableDefinitionNotFound',
  'Không xác định được AWS region (điền thủ công)': 'backend.noAwsRegion',
  'Loại đối tượng không được hỗ trợ': 'backend.unsupportedObjectKind',
  'Lệnh rỗng': 'backend.emptyCommand',
  'Stream cần ít nhất một field': 'backend.streamNeedsField',
  // redis_cmds.rs + redis_db.rs
  'Lệnh không hợp lệ: thiếu dấu nháy đóng': 'backend.redisBadQuote',
  'Chế độ chỉ đọc: không thể ghi vào Redis': 'backend.redisReadOnly',
  'Server không có module RedisJSON': 'backend.redisNoJsonModule',
  'Chưa có pattern để xoá': 'backend.redisNoPattern',
  'Chưa chọn channel để nghe': 'backend.redisNoChannel',
  'mTLS cần cả chứng chỉ client và khoá client': 'backend.mtlsIncomplete',
  'IAM chỉ hỗ trợ postgres/mysql': 'backend.iamOnlyPgMysql',
  'MySQL không hỗ trợ đổi tên database.': 'backend.mysqlNoRenameDb',
  'SQLite không hỗ trợ đổi tên database.': 'backend.sqliteNoRenameDb',
  'SQLite không hỗ trợ xóa database': 'backend.sqliteNoDropDb',
  'SQLite không hỗ trợ tạo database (mỗi tệp là một database)': 'backend.sqliteNoCreateDb',
  'SQLite không hỗ trợ nhiều database trên một kết nối': 'backend.sqliteSingleDb',
  'Chỉ PostgreSQL mới hỗ trợ chọn schema': 'backend.schemaOnlyPostgres',
  'Thiếu tên schema': 'backend.missingSchemaName',
  'CASCADE chỉ được hỗ trợ trên PostgreSQL': 'backend.cascadeOnlyPostgres',
  'Phiên terminal đã đóng': 'backend.terminalClosed',
  'Tham số truy vấn chỉ hỗ trợ một câu lệnh. Vui lòng chạy từng câu lệnh riêng hoặc tắt Tham số Truy vấn.':
    'backend.paramsSingleStatement',
  'Xác thực SSH thất bại: sai tài khoản, mật khẩu hoặc khóa.': 'backend.sshAuthFailed',
  'database không tồn tại': 'backend.databaseNotExist',
  // db_compare.rs — warnings (returned in the `warnings` array, not as errors)
  'Hai phía đang trỏ cùng một database.': 'backend.compareSameDatabase',
  'Hai bên lệch cột: chỉ so những cột có ở cả hai bên.': 'backend.compareColumnMismatch',
  'Thiếu tên bảng': 'backend.missingTableName',
  'Thiếu tên database': 'backend.missingDatabaseName',
  'Thiếu danh sách bảng': 'backend.missingTableList',
  'Thiếu danh sách thay đổi': 'backend.missingChangeList',
  'Thiếu đường dẫn tệp SQLite': 'backend.missingSqlitePath',
  'Thiếu địa chỉ máy chủ SSH': 'backend.missingSshHost',
  'Thiếu private key cho xác thực SSH bằng khóa': 'backend.missingSshKey',
  'Thiếu key': 'backend.missingKey',
  'Thiếu host RDS': 'backend.missingRdsHost',
  'Thiếu DB user cho IAM': 'backend.missingIamDbUser',
  'Thiếu AWS Access Key ID': 'backend.missingAwsAccessKeyId',
  'Thiếu AWS Secret Access Key': 'backend.missingAwsSecretKey',
  'Thiếu tên AWS profile': 'backend.missingAwsProfile',
  // data_generator.rs
  'Chưa chọn bảng nào để sinh dữ liệu': 'backend.dataGenNoTable',
  'Regex không hỗ trợ nhóm dạng (?...)': 'backend.rxNoGroupQuestion',
  "Regex thiếu dấu ')'": 'backend.rxMissingParen',
  "Regex thiếu dấu ']'": 'backend.rxMissingBracket',
  "Regex thiếu dấu '}'": 'backend.rxMissingBrace',
  "Regex kết thúc bằng dấu '\\'": 'backend.rxTrailingBackslash',
  'Regex không hỗ trợ backreference': 'backend.rxNoBackreference',
  'Regex không hỗ trợ neo dạng \\b': 'backend.rxNoAnchorWord',
  "Regex không hỗ trợ neo '^' và '$'": 'backend.rxNoAnchors',
  'Lớp ký tự [...] rỗng': 'backend.rxEmptyClass',
  'Regex không hỗ trợ ký tự này trong [...]': 'backend.rxUnsupportedInClass',
};

/**
 * Rust messages deliberately folded into another entry's wording because they say the
 * same thing (one concept -> one translation). For these the Vietnamese output is the
 * canonical sibling's wording, not the original literal — listed here so the round-trip
 * test can tell an intentional merge from an accidental transcription error.
 */
export const NORMALIZED_ALIASES = new Set(['Chưa kết nối database']);

/**
 * Templated backend messages. Each rule translates only the Vietnamese *framing* and
 * passes the interpolated payload (usually a driver error, which is already in the
 * server's own language) through untouched.
 *
 * Order matters: the first match wins, so a longer prefix must come before a shorter
 * one that would also match it.
 */
export const PATTERNS: { re: RegExp; key: string; nested?: boolean }[] = [
  { re: /^Lỗi khi chạy lệnh SQL: ([\s\S]*?)\. Chi tiết: ([\s\S]*)$/, key: 'backend.sqlFailed' },
  // database.rs — a statement's time fence (the connection's `statementTimeoutSecs`).
  { re: /^Câu lệnh đã chạy quá ([\d]+) giây và bị dừng$/, key: 'backend.statementTimeout' },
  { re: /^Lỗi tại câu lệnh:\n([\s\S]*)\n\nChi tiết: ([\s\S]*)$/, key: 'backend.sqlStatementFailed' },
  { re: /^Lỗi kết nối SSH tới ([^\s]+): ([\s\S]*)$/, key: 'backend.sshConnectFailed' },
  { re: /^Lỗi xác thực SSH bằng mật khẩu: ([\s\S]*)$/, key: 'backend.sshPasswordAuthFailed' },
  { re: /^Lỗi xác thực SSH bằng khóa: ([\s\S]*)$/, key: 'backend.sshKeyAuthFailed' },
  { re: /^Lỗi mở kênh SSH: ([\s\S]*)$/, key: 'backend.sshChannelFailed' },
  { re: /^Lỗi mở cổng chuyển tiếp local: ([\s\S]*)$/, key: 'backend.localForwardFailed' },
  { re: /^Lỗi mở shell cục bộ: ([\s\S]*)$/, key: 'backend.localShellFailed' },
  { re: /^Lỗi mở shell: ([\s\S]*)$/, key: 'backend.shellFailed' },
  { re: /^Lỗi mở PTY cục bộ: ([\s\S]*)$/, key: 'backend.localPtyFailed' },
  { re: /^Lỗi yêu cầu PTY: ([\s\S]*)$/, key: 'backend.ptyRequestFailed' },
  { re: /^Lỗi đọc file private key '([^']*)': ([\s\S]*)$/, key: 'backend.readPrivateKeyFileFailed' },
  { re: /^Lỗi đọc nội dung private key: ([\s\S]*)$/, key: 'backend.readPrivateKeyFailed' },
  // mcp/audit_file.rs — the encrypted audit log on disk. Only the WRITER's failures surface here;
  // a line that fails to decrypt is counted rather than thrown, because that is the tamper signal.
  { re: /^Không lấy được khoá mã hoá nhật ký MCP: ([\s\S]*)$/, key: 'backend.mcpAuditKeyFailed' },
  { re: /^Khoá mã hoá nhật ký MCP không hợp lệ: ([\s\S]*)$/, key: 'backend.mcpAuditKeyInvalid' },
  { re: /^Không ghi được nhật ký MCP: ([\s\S]*)$/, key: 'backend.mcpAuditWriteFailed' },
  { re: /^Không sinh được khoá mã hoá: ([\s\S]*)$/, key: 'backend.mcpAuditKeyGenFailed' },
  { re: /^PING lỗi: ([\s\S]*)$/, key: 'backend.pingFailed' },
  { re: /^Không thể kết nối Redis: ([\s\S]*)$/, key: 'backend.redisConnectFailed' },
  // redis_db.rs — refused commands and pagination
  { re: /^Lệnh '([^']*)' bị chặn ở chế độ chỉ đọc$/, key: 'backend.redisReadOnlyCmd' },
  // redis_db.rs — the cap on a DUMP/RESTORE batch. The number is inside the message
  // (`TRANSFER_BATCH_MAX`), so this is a regex rather than an EXACT entry.
  { re: /^Mỗi lượt chỉ nhận tối đa (\d+) key$/, key: 'backend.redisTransferBatchTooBig' },
  {
    re: /^Lệnh '([^']*)' cần kết nối riêng — dùng tab Pub\/Sub hoặc Profiler$/,
    key: 'backend.redisBlockingCmd',
  },
  { re: /^Chưa hỗ trợ phân trang cho kiểu '([^']*)'$/, key: 'backend.redisNoPagingForType' },
  { re: /^Schema '([^']*)' không tồn tại$/, key: 'backend.schemaNotFound' },
  // `nested` — the payload is one of our own TLS messages when the dedicated connection fails
  // while building the client, so it has to go through the table instead of staying Vietnamese
  // inside a translated frame.
  {
    re: /^Không mở được kết nối riêng cho Redis: ([\s\S]*)$/,
    key: 'backend.redisPushConnFailed',
    nested: true,
  },
  { re: /^Chỉ phân tích ([\d]+) key lấy mẫu — số liệu là ước lượng\.$/, key: 'backend.redisAnalysisSampled' },
  // redis_db.rs — the SSL tab's TLS certificates
  { re: /^Không đọc được chứng chỉ CA '([^']*)': ([\s\S]*)$/, key: 'backend.readCaCertFailed' },
  { re: /^Không đọc được chứng chỉ client '([^']*)': ([\s\S]*)$/, key: 'backend.readClientCertFailed' },
  { re: /^Không đọc được khoá client '([^']*)': ([\s\S]*)$/, key: 'backend.readClientKeyFailed' },
  { re: /^Cấu hình TLS không hợp lệ: ([\s\S]*)$/, key: 'backend.tlsConfigInvalid', nested: true },
  { re: /^Không mở được kho bí mật của hệ điều hành: ([\s\S]*)$/, key: 'backend.secretStoreOpenFailed' },
  {
    re: /^Không lưu được '([^']*)' vào kho bí mật: ([\s\S]*)\. Bí mật quá dài \(private key lớn\) có thể vượt giới hạn của kho HĐH\.$/,
    key: 'backend.secretWriteFailed',
  },
  { re: /^Không đọc được '([^']*)' từ kho bí mật: ([\s\S]*)$/, key: 'backend.secretReadFailed' },
  { re: /^Không xoá được '([^']*)' khỏi kho bí mật: ([\s\S]*)$/, key: 'backend.secretDeleteFailed' },
  { re: /^Không đọc được file credentials '([^']*)': ([\s\S]*)$/, key: 'backend.readCredentialsFailed' },
  { re: /^Profile '([^']*)' thiếu aws_access_key_id\/aws_secret_access_key$/, key: 'backend.profileMissingAwsKeys' },
  // db_compare.rs
  { re: /^Không mở được tệp SQLite '([^']*)': ([\s\S]*)$/, key: 'backend.sqliteOpenFailed' },
  { re: /^Bảng '([^']*)' không có ở nguồn$/, key: 'backend.tableMissingInSource' },
  { re: /^Bảng '([^']*)' không có ở đích$/, key: 'backend.tableMissingInTarget' },
  { re: /^Bảng '([^']*)' không có cột nào chung giữa hai bên$/, key: 'backend.tableNoCommonColumn' },
  {
    re: /^Bảng '([^']*)' không có khóa chính — hãy chọn cột khóa để so dữ liệu$/,
    key: 'backend.tableNoPrimaryKeyForCompare',
  },
  { re: /^Cột khóa '([^']*)' không có ở cả hai bên$/, key: 'backend.keyColumnMissing' },
  {
    re: /^Hai phía khác hệ quản trị \(([^)]*)\): kiểu dữ liệu và giá trị mặc định trong SQL đồng bộ có thể phải sửa tay\.$/,
    key: 'backend.compareDialectMismatch',
  },
  { re: /^Chỉ so ([\d]+) dòng đầu \(theo thứ tự khóa\) của mỗi bên\.$/, key: 'backend.compareRowLimit' },
  { re: /^Đích có ([\d]+) dòng trùng khóa — chỉ dòng cuối được đem so\.$/, key: 'backend.compareDuplicateKeys' },
  // data_generator.rs — regex subset parser
  { re: /^Regex không hợp lệ tại vị trí ([\d]+)$/, key: 'backend.rxInvalidAt' },
  { re: /^Lượng từ '([^']*)' không có ký tự đứng trước$/, key: 'backend.rxQuantNoAtom' },
  { re: /^Lượng từ \{([^}]*)\} không hợp lệ$/, key: 'backend.rxQuantInvalid' },
  { re: /^Lượng từ tối đa là ([\d]+)$/, key: 'backend.rxQuantMax' },
  { re: /^Lượng từ \{([^}]*)\} có min > max$/, key: 'backend.rxQuantMinMax' },
  // data_generator.rs — spec/column errors. `nested` = the payload is itself one of our
  // messages (a regex parser error), so it must go through the table too instead of staying
  // Vietnamese inside a translated frame.
  { re: /^Regex của cột '([^']*)' không hợp lệ: ([\s\S]*)$/, key: 'backend.dataGenRegexInvalid', nested: true },
  { re: /^Cột '([^']*)' thiếu biểu thức regex$/, key: 'backend.dataGenRegexMissing' },
  { re: /^Cột '([^']*)' chưa có danh sách giá trị có trọng số$/, key: 'backend.dataGenWeightedEmpty' },
  { re: /^Cột '([^']*)' chưa có danh sách giá trị$/, key: 'backend.dataGenListEmpty' },
  { re: /^Cột '([^']*)' chưa có biểu thức SQL$/, key: 'backend.dataGenExprEmpty' },
  { re: /^Cột '([^']*)' chưa chọn bảng\/cột tham chiếu$/, key: 'backend.dataGenFkMissing' },
  {
    re: /^Không sinh đủ giá trị khác nhau cho cột '([^']*)' sau ([\d]+) lần thử$/,
    key: 'backend.dataGenUniqueExhausted',
  },
  { re: /^Generator '([^']*)' không được hỗ trợ$/, key: 'backend.dataGenUnknownGenerator' },
  {
    re: /^Bảng cha '([^']*)' không có dòng nào để lấy khóa ngoại cho cột '([^']*)'$/,
    key: 'backend.dataGenFkParentEmpty',
  },
  {
    re: /^Xem trước: khóa ngoại của cột '([^']*)' là ƯỚC LƯỢNG vì bảng cha '([^']*)' còn rỗng; khi sinh thật sẽ lấy khóa thật của bảng cha\.$/,
    key: 'backend.dataGenFkEstimated',
  },
  { re: /^Bảng '([^']*)' không có cột nào để sinh dữ liệu$/, key: 'backend.dataGenAllSkipped' },
  { re: /^Không có cấu hình sinh dữ liệu cho bảng '([^']*)'$/, key: 'backend.dataGenNoSpec' },
  {
    re: /^Các bảng tham chiếu vòng: ([\s\S]*)\. Hãy bật 'Tắt ràng buộc' khi sinh\.$/,
    key: 'backend.dataGenCycle',
  },
  { re: /^Không xoá được dữ liệu cũ của bảng '([^']*)': ([\s\S]*)$/, key: 'backend.dataGenDeleteFailed' },
  { re: /^Lỗi khi chèn dữ liệu vào bảng '([^']*)': ([\s\S]*)$/, key: 'backend.dataGenInsertFailed' },
];

/**
 * Maps one backend message to the active language. Returns the input unchanged when
 * nothing matches — the caller can always display the result.
 */
export function translateBackendError(raw: string): string {
  if (!raw) return raw;
  const text = raw.trim();

  const exact = EXACT[text];
  if (exact) return i18n.t(exact as never);

  for (const { re, key, nested } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Rust interpolates positionally, so the capture groups map to {{a}}, {{b}}.
      const b = m[2] ?? '';
      return i18n.t(key as never, { a: m[1] ?? '', b: nested ? translateBackendError(b) : b });
    }
  }
  return raw;
}

/**
 * Walks a Tauri command result and translates the fields the backend uses to carry
 * an error (`message`, `error`). Everything else is passed through by reference, so
 * result rows are never copied.
 */
export function translateResultErrors<T>(res: T): T {
  if (!res || typeof res !== 'object') return res;
  const obj = res as Record<string, unknown>;
  for (const field of ['message', 'error'] as const) {
    const v = obj[field];
    // A successful command may put a status message in `message`; translating it is
    // harmless because a non-matching string comes back unchanged.
    if (typeof v === 'string' && v) obj[field] = translateBackendError(v);
  }
  return res;
}
