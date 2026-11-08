use crate::{
    auth::{PasswordHash, Sessions},
    config::{valid_id, Profiles, ACTIONS},
    dispatcher::Dispatcher,
    input::InputAdapter,
    rate_limit::RateLimit,
};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
    HeaderMap, Method, Request, Response,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

type Reply = Response<Full<Bytes>>;
#[derive(Clone, Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}
impl ApiError {
    fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    fn reply(self) -> Reply {
        json_reply(
            self.status,
            json!({"code":self.code,"message":self.message}),
        )
    }
}
fn response(status: u16, content_type: &'static str, body: Bytes) -> Reply {
    let mut reply = Response::builder().status(status)
        .header("Content-Type", content_type).header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        .header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer")
        .header("X-Frame-Options", "DENY").header("Connection", "close");
    if status == 429 {
        reply = reply.header("Retry-After", "2");
    }
    reply
        .body(Full::new(body))
        .expect("constant response headers")
}
fn json_reply(status: u16, body: Value) -> Reply {
    response(
        status,
        "application/json; charset=utf-8",
        Bytes::from(body.to_string()),
    )
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}
async fn body(request: &mut Request<Incoming>) -> Result<Value, ApiError> {
    if request.headers().contains_key("content-encoding") {
        return Err(ApiError::new(
            415,
            "content_encoding",
            "Encoded bodies are unsupported.",
        ));
    }
    let content_type = single_header(request.headers(), "content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid_type = content_type == "application/json"
        || content_type.split_once(';').is_some_and(|(kind, charset)| {
            kind.trim_end() == "application/json" && charset.trim_start() == "charset=utf-8"
        });
    if !valid_type {
        return Err(ApiError::new(415, "content_type", "Use application/json."));
    }
    if single_header(request.headers(), "content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|size| size > 1024)
    {
        return Err(ApiError::new(413, "body_too_large", "Body exceeds 1 KiB."));
    }
    timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        while let Some(frame) = request.body_mut().frame().await {
            let frame = frame
                .map_err(|_| ApiError::new(400, "body_aborted", "Request body interrupted."))?;
            if let Some(data) = frame.data_ref() {
                if bytes.len() + data.len() > 1024 {
                    return Err(ApiError::new(413, "body_too_large", "Body exceeds 1 KiB."));
                }
                bytes.extend_from_slice(data);
            } else {
                return Err(ApiError::new(
                    400,
                    "invalid_json",
                    "Request trailers are unsupported.",
                ));
            }
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::new(400, "invalid_json", "Invalid JSON body."))
    })
    .await
    .map_err(|_| ApiError::new(400, "body_timeout", "Request body timed out."))?
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginRequest {
    credential: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub request_id: String,
    pub profile_id: String,
    pub action: String,
}
impl ActionRequest {
    pub fn parse(value: Value) -> Result<Self, ApiError> {
        let invalid = || ApiError::new(400, "invalid_action", "Invalid action request.");
        let mut action: Self = serde_json::from_value(value).map_err(|_| invalid())?;
        action.request_id.make_ascii_lowercase();
        let id = action.request_id.as_bytes();
        if id.len() != 36
            || ![8, 13, 18, 23].iter().all(|i| id[*i] == b'-')
            || !id
                .iter()
                .enumerate()
                .all(|(i, b)| [8, 13, 18, 23].contains(&i) || b.is_ascii_hexdigit())
            || !(b'1'..=b'8').contains(&id[14])
            || !b"89ab".contains(&id[19])
            || !valid_id(&action.profile_id)
            || !ACTIONS.contains(&action.action.as_str())
        {
            return Err(invalid());
        }
        Ok(action)
    }
}
struct Limits {
    pre_auth: RateLimit,
    logins: RateLimit,
    global_logins: RateLimit,
    actions: RateLimit,
}
impl Limits {
    fn new() -> Self {
        Self {
            pre_auth: RateLimit::new(0.5, 10, 1024),
            logins: RateLimit::new(5.0 / 60.0, 3, 1024),
            global_logins: RateLimit::new(20.0 / 60.0, 5, 1),
            actions: RateLimit::new(5.0, 3, 1),
        }
    }
}
struct HttpState {
    dispatcher: Arc<Dispatcher>,
    authority: String,
    profiles: Profiles,
    sessions: Arc<Sessions>,
    limits: Mutex<Limits>,
    active: AtomicBool,
}
impl HttpState {
    fn limit(&self, take: impl FnOnce(&mut Limits) -> bool) -> bool {
        self.limits.lock().is_ok_and(|mut limits| take(&mut limits))
    }
    async fn handle(
        self: Arc<Self>,
        mut request: Request<Incoming>,
        peer: SocketAddr,
    ) -> Result<Reply, Infallible> {
        Ok(match self.route(&mut request, peer).await {
            Ok(reply) => reply,
            Err(error) => error.reply(),
        })
    }
    async fn route(
        &self,
        request: &mut Request<Incoming>,
        peer: SocketAddr,
    ) -> Result<Reply, ApiError> {
        if !self.active.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "server_stopped", "Server stopped."));
        }
        let source = peer.ip().to_string();
        if !self.limit(|l| l.pre_auth.take(&source)) {
            return Err(ApiError::new(429, "rate_limited", "Too many requests."));
        }
        let origin = format!("http://{}", self.authority);
        let headers = request.headers();
        let rejected = || ApiError::new(403, "origin_rejected", "Host or origin rejected.");
        if single_header(headers, "host") != Some(&self.authority)
            || headers.contains_key("origin") && single_header(headers, "origin") != Some(&origin)
            || headers.contains_key("sec-fetch-site")
                && !matches!(
                    single_header(headers, "sec-fetch-site"),
                    Some("same-origin" | "none")
                )
            || request.uri().scheme().is_some()
            || request.uri().authority().is_some()
        {
            return Err(rejected());
        }
        if request.method() == Method::POST && single_header(headers, "origin") != Some(&origin) {
            return Err(rejected());
        }
        let route = request
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let asset: Option<(&'static str, &'static [u8])> = match route.as_str() {
            "/" => Some((
                "text/html; charset=utf-8",
                include_bytes!("../../dist/web/index.html"),
            )),
            "/app.js" => Some((
                "text/javascript; charset=utf-8",
                include_bytes!("../../dist/web/app.js"),
            )),
            "/styles.css" => Some((
                "text/css; charset=utf-8",
                include_bytes!("../../dist/web/styles.css"),
            )),
            "/emulator-pcsx2.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-pcsx2.png"))),
            "/emulator-dolphin.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-dolphin.png"))),
            "/emulator-duckstation.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-duckstation.png"))),
            "/emulator-ppsspp.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-ppsspp.png"))),
            "/emulator-mgba.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-mgba.png"))),
            "/emulator-rpcs3.png" => Some(("image/png", include_bytes!("../../dist/web/emulator-rpcs3.png"))),
            "/icon.png" => Some(("image/png", include_bytes!("../../dist/web/icon.png"))),
            _ => None,
        };
        if let Some((kind, bytes)) = asset {
            if matches!(*request.method(), Method::GET | Method::HEAD) {
                return Ok(response(
                    200,
                    kind,
                    if request.method() == Method::HEAD {
                        Bytes::new()
                    } else {
                        Bytes::from_static(bytes)
                    },
                ));
            }
        }
        let not_found = || ApiError::new(404, "not_found", "Not found.");
        if !route.starts_with("/api/") {
            return Err(not_found());
        }
        if route == "/api/login" && request.method() == Method::POST {
            if !self.limit(|l| l.logins.take(&source) && l.global_logins.take("login")) {
                return Err(ApiError::new(
                    429,
                    "login_limited",
                    "Too many sign-in attempts. Wait before trying again.",
                ));
            }
            let login: LoginRequest = serde_json::from_value(body(request).await?)
                .map_err(|_| ApiError::new(400, "invalid_login", "Enter a valid password."))?;
            if !(1..=128).contains(&login.credential.encode_utf16().count()) {
                return Err(ApiError::new(
                    400,
                    "invalid_login",
                    "Enter a valid password.",
                ));
            }
            return match self.sessions.login(login.credential).await {
                Ok(Some(token)) => Ok(json_reply(200, json!({"token":token}))),
                Ok(None) => Err(ApiError::new(401, "unauthorized", "Password rejected.")),
                Err(_) => Err(ApiError::new(
                    429,
                    "login_limited",
                    "Sign-in is busy. Wait before trying again.",
                )),
            };
        }
        let authorization = single_header(request.headers(), "authorization");
        if !self.sessions.authenticate(authorization) {
            return Err(ApiError::new(401, "unauthorized", "Sign in again."));
        }
        if route == "/api/logout" && request.method() == Method::POST {
            self.sessions.logout(authorization);
            return Ok(json_reply(200, json!({"status":"signed_out"})));
        }
        if route == "/api/health" && request.method() == Method::GET {
            return Ok(json_reply(
                200,
                json!({"ready":self.dispatcher.available(),"inputAvailable":self.dispatcher.available()}),
            ));
        }
        if route == "/api/profiles" && request.method() == Method::GET {
            return Ok(json_reply(200, self.profiles.public_view()));
        }
        if route != "/api/actions" || request.method() != Method::POST {
            return Err(not_found());
        }
        let action = ActionRequest::parse(body(request).await?)?;
        if !self.limit(|l| l.actions.take("global")) {
            return Err(ApiError::new(429, "rate_limited", "Too many actions."));
        }
        let result = self.dispatcher.dispatch(action).await;
        Ok(json_reply(result.status, result.body))
    }
}

pub struct RunningServer {
    pub url: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
    shared: Arc<HttpState>,
}
impl RunningServer {
    pub async fn bind(
        host: &str,
        port: u16,
        password: PasswordHash,
        profiles: Profiles,
        work: Arc<Semaphore>,
        input: Arc<dyn InputAdapter>,
    ) -> Result<Self, String> {
        crate::config::validate_host(host, &crate::config::addresses()?)?;
        let profiles = profiles.validate()?;
        let listener = TcpListener::bind((host, port))
            .await
            .map_err(|_| "Server startup failed. Check the address and port availability.")?;
        let address = listener
            .local_addr()
            .map_err(|_| "Cannot read server address.")?;
        let shared = Arc::new(HttpState {
            dispatcher: Dispatcher::new(profiles.clone(), input),
            authority: address.to_string(),
            profiles,
            sessions: Arc::new(Sessions::new(password, work)),
            limits: Mutex::new(Limits::new()),
            active: AtomicBool::new(true),
        });
        let (shutdown, mut stopped) = oneshot::channel();
        let state = shared.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            let result = loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break Ok(()),
                    _ = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let (stream, peer) = match accepted { Ok(connection) => connection, Err(_) => break Err("Server listener failed.".into()) };
                        if connections.len() >= 128 { drop(stream); continue; }
                        let shared = state.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request| shared.clone().handle(request, peer));
                            let mut protocol = http1::Builder::new();
                            protocol.keep_alive(false).max_headers(32).max_header_size(8192).max_buf_size(8192)
                                .header_read_timeout(Duration::from_secs(5)).timer(TokioTimer::new());
                            let _ = timeout(Duration::from_secs(5), protocol.serve_connection(TokioIo::new(stream), service)).await;
                        });
                    }
                }
            };
            drop(listener);
            state.active.store(false, Ordering::SeqCst);
            state.sessions.clear();
            let cleanup = state.dispatcher.close().await;
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            cleanup.and(result)
        });
        Ok(Self {
            url: format!("http://{address}"),
            shutdown: Some(shutdown),
            task,
            shared,
        })
    }
    pub fn failed(&self) -> bool {
        self.task.is_finished()
    }
    pub fn input_available(&self) -> bool {
        self.shared.dispatcher.available()
    }
    pub async fn close(mut self) -> Result<(), String> {
        self.shared.active.store(false, Ordering::SeqCst);
        self.shared.sessions.clear();
        if let Some(stop) = self.shutdown.take() {
            let _ = stop.send(());
        }
        match timeout(Duration::from_secs(8), &mut self.task).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Server shutdown failed.".into()),
            Err(_) => {
                self.task.abort();
                let _ = self.task.await;
                Err("Server shutdown timed out.".into())
            }
        }
    }
}
