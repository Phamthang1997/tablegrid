//! What gets served, and the two doors in front of it: `Origin`/`Host` (layer 1) and the bearer
//! token (layer 2). Everything past them belongs to `rmcp`.
//!
//! `server.rs` owns *when* this runs; this file owns *who gets through*.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use tokio_util::sync::CancellationToken;

use super::audit::{self, Denial};
use super::tools::TableGridMcp;

/// The path AI clients point at: `http://127.0.0.1:<port>/mcp`.
pub const MOUNT_PATH: &str = "/mcp";

/// What the two guards need in order to answer. Cloned per request, so both fields stay cheap.
#[derive(Clone)]
struct Guard {
    port: u16,
    /// Read from the keyring once when the server starts - see `auth::verify`.
    token: Arc<str>,
}

/// The whole served surface: the MCP service, behind the token door, behind the origin door.
///
/// Layer order is the reverse of the call order in axum - the LAST layer added is the outermost. So
/// `Origin`/`Host` is added last and runs first, which is what we want: a request from a web page
/// must be turned away before anything looks at its credentials.
pub fn router(port: u16, token: Arc<str>, cancel: CancellationToken) -> Router {
    // **Session mode stays ON (rmcp's default) - now a measured decision, not an unexamined one.**
    //
    // Turning it off (`with_legacy_session_mode(false)`) looked right, and the reasoning was sound as
    // far as it went: nothing here needs a session - the tools are stateless reads, and the only real
    // state, which connection is shared, lives in `AppState` rather than in the transport - and
    // SEP-2567 removes sessions from protocol 2026-07-28 anyway. It also promised to kill a genuine
    // annoyance: in session mode every TableGrid restart invalidates every client's session, which
    // reaches the user as `session not found`.
    //
    // It broke a client that had been working. Stateless has no server-to-client stream, so
    // `GET /mcp` answers **405** where session mode answers **200** - and Antigravity opens exactly
    // that stream (its own name for it is `subscriptions/listen`), then abandons its whole tool list
    // when it cannot. Measured both ways against the real client.
    //
    // So the trade is deliberate: keep sessions, and a restart of TableGrid costs connected clients
    // one reconnect. That is a transient with an obvious remedy; the alternative was a permanent
    // failure for one of the two clients this build is actually tested against. Anyone tempted to
    // flip this again should read `docs/mcp-server-plan.md` §6 Bước 3 first.
    let service = StreamableHttpService::new(
        || Ok(TableGridMcp::new()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel),
    );
    let guard = Guard { port, token };

    Router::new()
        .nest_service(MOUNT_PATH, service)
        .layer(middleware::from_fn_with_state(guard.clone(), guard_token))
        .layer(middleware::from_fn_with_state(guard, guard_origin))
}

/// Layer 1. Binding to loopback keeps other machines out; it does **not** keep out a page running in
/// the user own browser, which can `fetch()` a loopback port, nor DNS rebinding, which forges
/// `Host`. These two header checks are what close both.
///
/// A desktop MCP client sends no `Origin` at all, so an absent one passes. A present one has to be
/// loopback. And no CORS headers are ever emitted anywhere in this router, so even a request that
/// somehow got through would produce a response the browser refuses to hand to the page.
async fn guard_origin(State(g): State<Guard>, req: Request<Body>, next: Next) -> Response {
    let origin_ok = match req.headers().get(header::ORIGIN) {
        None => true,
        Some(v) => v.to_str().map(is_loopback_origin).unwrap_or(false),
    };
    if !origin_ok {
        return deny(
            StatusCode::FORBIDDEN,
            "origin not allowed",
            Denial::BadOrigin,
            &req,
        );
    }

    // HTTP/2 carries the authority in the pseudo-header rather than in `Host`; axum surfaces it on
    // the URI. Checking only one of the two would leave a hole open on whichever protocol the
    // client happens to negotiate.
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_owned()));
    if !host.map(|h| is_expected_host(&h, g.port)).unwrap_or(false) {
        return deny(
            StatusCode::FORBIDDEN,
            "host not allowed",
            Denial::BadOrigin,
            &req,
        );
    }

    next.run(req).await
}

/// Is this one of the OAuth discovery paths a client probes before trusting a configured header?
///
/// Used to keep those probes **out of the audit log**, and for nothing else. An earlier version also
/// answered them with 404 instead of letting them reach layer 2, on the reasoning that a 401 plus
/// `WWW-Authenticate: Bearer` invites an OAuth flow this server does not implement. That conflated
/// two separate things - "do not spam the log" and "change the status code" - and only the first was
/// ever the goal. The second broke a client that had been working, so the wire behaviour is back to
/// what it was: these probes fall through and get the ordinary 401.
fn is_oauth_discovery(path: &str) -> bool {
    path.starts_with("/.well-known/")
}

/// Layer 2. `Authorization: Bearer <token>`, compared in constant time against the token minted into
/// the OS keyring.
async fn guard_token(State(g): State<Guard>, req: Request<Body>, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_value)
        .map(str::to_owned);

    match presented {
        Some(t) if super::auth::verify(&t, &g.token) => next.run(req).await,
        _ => {
            const MSG: &str = "missing or invalid bearer token";
            // Same rule as `deny`: an OAuth discovery probe is expected to arrive without a token,
            // so it is refused identically but never written to the log.
            if !is_oauth_discovery(req.uri().path()) {
                audit::record(
                    audit::entry(&req_label(&req), None, None, 0)
                        .denied(Denial::BadToken, MSG.to_string()),
                );
            }
            // `WWW-Authenticate` is what tells a client it needs to send a token rather than that
            // its request was malformed - the difference between a fixable config and a mystery.
            (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, "Bearer")],
                format!("{MSG}\n"),
            )
                .into_response()
        }
    }
}

/// The token out of an `Authorization` value. The scheme is case-insensitive per RFC 7235, and
/// clients do differ on it.
fn bearer_value(raw: &str) -> Option<&str> {
    let (scheme, rest) = raw.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        Some(rest.trim())
    } else {
        None
    }
}

/// Is this `Origin` a loopback page?
///
/// Loopback only, any port: a page served from another local port is a far-fetched attacker next to
/// any site on the internet, and pinning the port would break local MCP clients that proxy.
fn is_loopback_origin(origin: &str) -> bool {
    // `null` is what a sandboxed iframe or a file:// page sends. It is not loopback, and treating it
    // as "no origin" would hand the check to exactly the contexts it exists to catch.
    let stripped = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    match stripped {
        Some(rest) => is_loopback_authority(rest),
        None => false,
    }
}

/// Is this `Host` the address we actually bound, on the port we actually bound?
///
/// Stricter than the origin check on purpose: the port is ours to know, and a `Host` naming a
/// different port is either a proxy we did not ask for or a rebinding attempt.
fn is_expected_host(host: &str, port: u16) -> bool {
    // No port at all cannot be us: the server never binds 80 or 443.
    match split_authority(host) {
        Some((name, p)) => p == port && is_loopback_name(name),
        None => false,
    }
}

fn is_loopback_authority(authority: &str) -> bool {
    match split_authority(authority) {
        Some((name, _)) => is_loopback_name(name),
        None => is_loopback_name(authority),
    }
}

/// Splits `host:port`, keeping `[::1]:port` in one piece.
fn split_authority(authority: &str) -> Option<(&str, u16)> {
    let (name, port) = match authority.strip_prefix('[') {
        Some(rest) => {
            let (inner, tail) = rest.split_once(']')?;
            (inner, tail.strip_prefix(':')?)
        }
        None => authority.rsplit_once(':')?,
    };
    Some((name, port.parse().ok()?))
}

fn is_loopback_name(name: &str) -> bool {
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

/// What the log calls a request that never reached a tool.
///
/// Layers 1 and 2 refuse before `rmcp` has parsed the JSON-RPC body, so there is no tool name to
/// record yet - the method and path are the whole truth we have, and they read as what they are
/// rather than as a tool that does not exist.
fn req_label(req: &Request<Body>) -> String {
    format!("{} {}", req.method(), req.uri().path())
}

/// Refuse, and **write it down**.
///
/// The recording is the point, not a nicety. These two layers are the ones that fire while a user is
/// still pointing a client at us - a wrong token, a stale port - and they used to leave no trace at
/// all, so the Requests panel read "no request yet" while the client was being turned away on every
/// retry. That is the one state a log like this exists to make visible.
///
/// Cost accepted: a client retrying in a loop writes one entry per attempt, so a misconfigured
/// client can push real entries out of the 500-deep ring. Bounded and self-inflicted, and coalescing
/// would mean the panel undercounting what actually happened - measure before trading that away.
fn deny(code: StatusCode, msg: &'static str, denial: Denial, req: &Request<Body>) -> Response {
    // Everything is refused the same way; only the LOGGING is conditional. An OAuth discovery probe
    // carries no `Authorization` by design, so auditing it would fill the panel with red rows for
    // entirely expected client behaviour - and a panel built to make real denials visible cannot
    // afford that. The client still gets the same answer it always did.
    if !is_oauth_discovery(req.uri().path()) {
        audit::record(audit::entry(&req_label(req), None, None, 0).denied(denial, msg.to_string()));
    }
    (code, format!("{msg}\n")).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_must_match_the_bound_port() {
        assert!(is_expected_host("127.0.0.1:45124", 45124));
        assert!(is_expected_host("localhost:45124", 45124));
        assert!(is_expected_host("[::1]:45124", 45124));
        // Another port is either a proxy nobody asked for or a rebinding attempt.
        assert!(!is_expected_host("127.0.0.1:45125", 45124));
        // The whole point of the check: a name that RESOLVES to loopback is still not loopback.
        assert!(!is_expected_host("evil.example.com:45124", 45124));
        assert!(!is_expected_host("127.0.0.1", 45124));
    }

    #[test]
    fn origin_must_be_loopback_or_absent() {
        assert!(is_loopback_origin("http://127.0.0.1:5173"));
        assert!(is_loopback_origin("http://localhost:3000"));
        assert!(is_loopback_origin("https://[::1]:8443"));
        assert!(!is_loopback_origin("https://evil.example.com"));
        // A sandboxed iframe or a file:// page. Not loopback, and not the same as sending nothing.
        assert!(!is_loopback_origin("null"));
        // A host that merely STARTS with the loopback text.
        assert!(!is_loopback_origin("http://127.0.0.1.evil.com"));
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_and_required() {
        assert_eq!(bearer_value("Bearer abc"), Some("abc"));
        assert_eq!(bearer_value("bearer abc"), Some("abc"));
        assert_eq!(bearer_value("BEARER  abc "), Some("abc"));
        assert_eq!(bearer_value("Basic abc"), None);
        assert_eq!(bearer_value("abc"), None);
    }
}

/// The guards, exercised over a real socket rather than by calling them directly.
///
/// Worth the extra machinery: every mistake this file can make - a layer added in the wrong order, a
/// guard that never runs because it was attached below the nested service, a bind that answers on
/// the wrong interface - is invisible to a unit test of the predicates above and obvious here.
#[cfg(test)]
pub(super) mod server_tests {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    pub(super) const TOKEN: &str = "test-token-not-from-the-keyring";

    /// Spawns the router on an ephemeral port. Returns the port and the handle to stop it with.
    pub(super) async fn spawn() -> (u16, CancellationToken, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let cancel = CancellationToken::new();
        let app = router(port, TOKEN.into(), cancel.child_token());
        let shutdown = cancel.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
        });
        (port, cancel, task)
    }

    /// A whole request/response, body included. Bounded by a timeout because a streamable-HTTP
    /// response can legitimately stay open.
    pub(super) async fn exchange(port: u16, headers: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        stream
            .write_all(request(headers, body).as_bytes())
            .await
            .expect("write");
        let mut out = Vec::new();
        // Bounded: a streamable-HTTP response can legitimately stay open, and a test that hangs is
        // worse than one that fails.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut out),
        )
        .await;
        String::from_utf8_lossy(&out).into_owned()
    }

    /// One well-formed POST to the mount path.
    ///
    /// Both `Accept` types are required by streamable HTTP - omit either and the server answers 406
    /// before any of this file's guards have run, which reads as a security bug that is not there.
    pub(super) fn request(headers: &str, body: &str) -> String {
        format!(
            "POST {MOUNT_PATH} HTTP/1.1\r\n{headers}Content-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// One raw HTTP/1.1 request; returns the status line only, so an SSE response cannot hang us.
    async fn status_line(port: u16, headers: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let req = request(headers, body);
        stream.write_all(req.as_bytes()).await.expect("write");
        let mut line = String::new();
        BufReader::new(stream)
            .read_line(&mut line)
            .await
            .expect("read");
        line
    }

    /// A raw GET, for the paths a client probes before it trusts its configured header.
    pub(super) async fn get_status(port: u16, path: &str, headers: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let req = format!("GET {path} HTTP/1.1\r\n{headers}Connection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await.expect("write");
        let mut line = String::new();
        BufReader::new(stream)
            .read_line(&mut line)
            .await
            .expect("read");
        line
    }

    #[tokio::test]
    async fn both_doors_answer_before_the_protocol_does() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let cancel = CancellationToken::new();
        let app = router(port, TOKEN.into(), cancel.child_token());

        let shutdown = cancel.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
        });

        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#;
        let host = format!("Host: 127.0.0.1:{port}\r\n");

        // A page in the user's browser, carrying a perfectly valid token: refused on the origin
        // alone, before anything reads the credential.
        let web = status_line(
            port,
            &format!("{host}Origin: https://evil.example.com\r\nAuthorization: Bearer {TOKEN}\r\n"),
            init,
        )
        .await;
        assert!(web.contains("403"), "browser origin got through: {web}");

        // A forged Host, i.e. DNS rebinding.
        let rebound = status_line(
            port,
            &format!("Host: evil.example.com:{port}\r\nAuthorization: Bearer {TOKEN}\r\n"),
            init,
        )
        .await;
        assert!(
            rebound.contains("403"),
            "forged host got through: {rebound}"
        );

        let anonymous = status_line(port, &host, init).await;
        assert!(
            anonymous.contains("401"),
            "no token got through: {anonymous}"
        );

        let wrong = status_line(port, &format!("{host}Authorization: Bearer nope\r\n"), init).await;
        assert!(wrong.contains("401"), "wrong token got through: {wrong}");

        // OAuth discovery is refused like anything else without a token - deliberately NOT a 404.
        // Answering 404 here (an earlier version did) changed the handshake for a client that had
        // been working; the log noise those probes caused is suppressed in `deny`/`guard_token`
        // instead, which was the only real goal. See `is_oauth_discovery`.
        let disco = get_status(port, "/.well-known/oauth-protected-resource", &host).await;
        assert!(
            disco.contains("401"),
            "oauth discovery should 401 like the rest: {disco}"
        );

        // The real thing. What rmcp answers is rmcp's business; what matters here is that neither
        // door turned it away.
        let ok = status_line(
            port,
            &format!("{host}Authorization: Bearer {TOKEN}\r\n"),
            init,
        )
        .await;
        assert!(
            !ok.contains("401") && !ok.contains("403"),
            "valid request blocked: {ok}"
        );

        cancel.cancel();
        let _ = task.await;
    }
}

/// The full MCP handshake against the real server, ending in `tools/list`.
///
/// This is the test that proves the tools are actually REGISTERED. `#[tool_handler]` wires the
/// router by macro, so a surface that silently lists nothing compiles perfectly well - and the
/// dead-code warning on the `tool_router` field is not evidence either way.
#[cfg(test)]
mod handshake_tests {
    use super::server_tests::*;

    /// Spec revision 2026-07-28 removed sessions entirely (SEP-2567), so there is no session id to
    /// carry. What replaces it is this header: rmcp rejects every non-`initialize` request that
    /// arrives without it.
    const PROTOCOL: &str = "2026-07-28";

    #[tokio::test]
    async fn tools_list_reports_every_tool() {
        let (port, cancel, task) = spawn().await;
        let auth = format!("Host: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n");

        let init = exchange(
            port,
            &auth,
            &format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{PROTOCOL}","capabilities":{{}},"clientInfo":{{"name":"test","version":"0"}}}}}}"#
            ),
        )
        .await;
        assert!(init.contains(" 200 "), "initialize failed: {init}");
        // The server has to introduce itself as this app, not as the SDK - see `tablegrid_identity`.
        assert!(init.contains("tablegrid"), "wrong server identity: {init}");

        let listed = exchange(
            port,
            // `Mcp-Method` is required from 2026-07-28 too: it lets a proxy route or authorise a
            // call without parsing the JSON body.
            &format!("{auth}MCP-Protocol-Version: {PROTOCOL}\r\nMcp-Method: tools/list\r\n"),
            // Stateless mode (SEP-2567) means every request carries its own negotiated context in
            // `_meta` instead of leaning on a session the server remembers.
            &format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{"_meta":{{"io.modelcontextprotocol/protocolVersion":"{PROTOCOL}","io.modelcontextprotocol/clientCapabilities":{{}}}}}}}}"#
            ),
        )
        .await;

        for tool in [
            "tablegrid_list_connections",
            "tablegrid_list_databases",
            "tablegrid_list_tables",
            "tablegrid_describe_table",
            "tablegrid_preview_table",
            "tablegrid_query",
            "tablegrid_mutate",
        ] {
            assert!(
                listed.contains(tool),
                "{tool} missing from tools/list: {listed}"
            );
        }
        // The generated schema has to arrive with them, or a client cannot call anything.
        assert!(
            listed.contains("connection_id"),
            "no parameter schema: {listed}"
        );

        cancel.cancel();
        let _ = task.await;
    }
}
