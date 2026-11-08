use emulator_remote::input::{InputAdapter, InputError, InputFuture, Shortcut};
use emulator_remote::{
    auth::PasswordHash,
    config::{self, DataPaths, Profiles},
    controller::Controller,
    http::{ActionRequest, RunningServer},
};
struct Unavailable;
impl InputAdapter for Unavailable {
    fn available(&self) -> bool {
        false
    }
    fn send(&self, _: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
        Box::pin(async { Err(InputError::Unavailable) })
    }
    fn close(&self) -> InputFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    time::timeout,
};

fn example() -> Profiles {
    serde_json::from_str::<Profiles>(include_str!("../../config/profiles.example.json"))
        .unwrap()
        .validate()
        .unwrap()
}

#[tokio::test]
async fn unchanged_phone_client_runs_through_real_rust_http_with_multiple_profiles() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    struct Recording {
        live: AtomicBool,
        sent: Mutex<Vec<Shortcut>>,
    }
    impl InputAdapter for Recording {
        fn available(&self) -> bool {
            self.live.load(Ordering::SeqCst)
        }
        fn send(&self, shortcut: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
            Box::pin(async move {
                self.sent.lock().unwrap().push(shortcut);
                Ok(())
            })
        }
        fn close(&self) -> InputFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.live.store(false, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    let input = Arc::new(Recording {
        live: AtomicBool::new(true),
        sent: Mutex::new(vec![]),
    });
    let mut profiles = example();
    let mut other = profiles.profiles[0].clone();
    other.id = "another-emulator".into();
    other.label = "Another emulator".into();
    other.process_names = vec!["another.exe".into()];
    other.actions.get_mut("saveState").unwrap().key = "F4".into();
    other.actions.remove("pauseResume");
    profiles.profiles.push(other);
    let server = RunningServer::bind(
        "127.0.0.1",
        0,
        password(),
        profiles,
        Arc::new(Semaphore::new(2)),
        input.clone(),
    )
    .await
    .unwrap();
    let node = std::env::var_os("EMULATOR_REMOTE_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = timeout(
        Duration::from_secs(25),
        tokio::process::Command::new(node)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/phone-flow.mjs"))
            .arg(&server.url)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    server.close().await.unwrap();
    assert!(
        output.status.success(),
        "phone client failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let sent = input.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].key, "F1");
    assert_eq!(sent[0].allowed_processes, vec!["pcsx2-qt.exe"]);
    assert_eq!(sent[1].key, "F4");
    assert_eq!(sent[1].allowed_processes, vec!["another.exe"]);
    assert!(!input.available());
}

#[tokio::test]
async fn reopened_controller_preserves_network_and_profiles_but_not_passwords() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("config");
    let controller = Controller::new(directory.clone()).unwrap();
    let reservation = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    controller
        .set_network("127.0.0.1".into(), port)
        .await
        .unwrap();
    let mut profiles = example();
    let mut other = profiles.profiles[0].clone();
    other.id = "second-emulator".into();
    other.label = "Second emulator".into();
    other.process_names = vec!["second.exe".into()];
    profiles.profiles.push(other);
    config::save_json(&directory, "profiles.local.json", &profiles).unwrap();
    let saved_profiles = std::fs::read(directory.join("profiles.local.json")).unwrap();
    controller
        .set_password("test-password".into(), "test-password".into())
        .await
        .unwrap();
    let state = controller.start().await.unwrap();
    let url = state.runtime.url.unwrap();
    let token = login(&url).await;
    assert_eq!(
        request(&url, "GET", "/api/profiles", None, Some(&token))
            .await
            .1["profiles"]
            .as_array()
            .unwrap()
            .len(),
        profiles.profiles.len()
    );
    controller.shutdown().await.unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    drop(listener);
    let reopened = Controller::new(directory.clone()).unwrap();
    let state = reopened.state().await.unwrap();
    assert_eq!(state.port, port);
    assert_eq!(state.host, "127.0.0.1");
    assert!(!state.password_enabled);
    assert!(reopened.start().await.is_err());
    assert_eq!(
        std::fs::read(directory.join("profiles.local.json")).unwrap(),
        saved_profiles
    );
    let settings = std::fs::read_to_string(directory.join("server.local.json")).unwrap();
    assert!(!settings.contains("password"));
}
fn password() -> PasswordHash {
    static HASH: OnceLock<PasswordHash> = OnceLock::new();
    HASH.get_or_init(|| PasswordHash::derive("test-password").unwrap())
        .clone()
}
async fn server(profiles: Profiles) -> RunningServer {
    RunningServer::bind(
        "127.0.0.1",
        0,
        password(),
        profiles,
        Arc::new(Semaphore::new(2)),
        Arc::new(Unavailable),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn http_dispatches_profile_chords_deduplicates_and_reports_live_health() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    struct RecordingInput {
        live: AtomicBool,
        sent: Mutex<Vec<Shortcut>>,
    }
    impl InputAdapter for RecordingInput {
        fn available(&self) -> bool {
            self.live.load(Ordering::SeqCst)
        }
        fn send(&self, shortcut: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
            Box::pin(async move {
                self.sent.lock().unwrap().push(shortcut);
                Ok(())
            })
        }
        fn close(&self) -> InputFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.live.store(false, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    let input = Arc::new(RecordingInput {
        live: AtomicBool::new(true),
        sent: Mutex::new(vec![]),
    });
    let mut profiles = example();
    let mut other = profiles.profiles[0].clone();
    other.id = "another-emulator".into();
    other.label = "Another emulator".into();
    other.process_names = vec!["another.exe".into()];
    other.actions.get_mut("saveState").unwrap().key = "F4".into();
    profiles.profiles.push(other);
    let server = RunningServer::bind(
        "127.0.0.1",
        0,
        password(),
        profiles,
        Arc::new(Semaphore::new(2)),
        input.clone(),
    )
    .await
    .unwrap();
    let token = login(&server.url).await;
    assert_eq!(
        request(&server.url, "GET", "/api/health", None, Some(&token))
            .await
            .1,
        json!({"ready":true,"inputAvailable":true})
    );
    let action = json!({"requestId":"00000000-0000-4000-8000-000000000001","profileId":"another-emulator","action":"saveState"});
    let first = request(
        &server.url,
        "POST",
        "/api/actions",
        Some(action.clone()),
        Some(&token),
    )
    .await;
    assert_eq!(first.0, 200);
    assert_eq!(first.1["status"], "sent");
    assert_eq!(
        request(
            &server.url,
            "POST",
            "/api/actions",
            Some(action.clone()),
            Some(&token)
        )
        .await,
        first
    );
    let mut conflict = action;
    conflict["action"] = json!("loadState");
    assert_eq!(
        request(
            &server.url,
            "POST",
            "/api/actions",
            Some(conflict),
            Some(&token)
        )
        .await
        .1["code"],
        "request_conflict"
    );
    {
        let sent = input.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].key, "F4");
        assert_eq!(sent[0].allowed_processes, vec!["another.exe"]);
    }
    input.live.store(false, Ordering::SeqCst);
    assert_eq!(
        request(&server.url, "GET", "/api/health", None, Some(&token))
            .await
            .1,
        json!({"ready":false,"inputAvailable":false})
    );
    server.close().await.unwrap();
}
async fn raw(url: &str, request: Vec<u8>) -> (u16, Vec<u8>, String) {
    let authority = url.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(authority).await.unwrap();
    stream.write_all(&request).await.unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(8), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let split = bytes
        .windows(4)
        .position(|b| b == b"\r\n\r\n")
        .expect("HTTP response");
    let headers = String::from_utf8(bytes[..split].to_vec()).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, bytes[split + 4..].to_vec(), headers)
}
async fn request(
    url: &str,
    method: &str,
    route: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (u16, Value) {
    let text = body.map(|v| v.to_string());
    let authorization = token
        .map(|v| format!("Authorization: Bearer {v}\r\n"))
        .unwrap_or_default();
    let content = text
        .as_ref()
        .map(|b| {
            format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                b.len()
            )
        })
        .unwrap_or_default();
    let bytes = format!("{method} {route} HTTP/1.1\r\nHost: {}\r\nOrigin: {url}\r\n{authorization}{content}Connection: close\r\n\r\n{}",
        url.strip_prefix("http://").unwrap(), text.unwrap_or_default()).into_bytes();
    let (status, body, _) = raw(url, bytes).await;
    (status, serde_json::from_slice(&body).unwrap())
}
async fn login(url: &str) -> String {
    let (status, value) = request(
        url,
        "POST",
        "/api/login",
        Some(json!({"credential":"test-password"})),
        None,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    value["token"].as_str().unwrap().to_string()
}

#[test]
fn profiles_remain_generic_and_public_view_omits_process_details() {
    let mut value: Value =
        serde_json::from_str(include_str!("../../config/profiles.example.json")).unwrap();
    let mut other = value["profiles"][0].clone();
    other["id"] = json!("duckstation");
    other["label"] = json!("DuckStation");
    other["processNames"] = json!(["duckstation-qt-x64-ReleaseLTCG.exe"]);
    value["profiles"].as_array_mut().unwrap().push(other);
    let profiles = serde_json::from_value::<Profiles>(value)
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(profiles.profiles.len(), 3);
    let public = profiles.public_view();
    assert_eq!(public["profiles"][2]["id"], "duckstation");
    assert_eq!(
        public["profiles"][0]["actions"]["previousSlot"]["shortcut"],
        "Shift+F2"
    );
    assert!(!public.to_string().contains("processNames"));
}
#[test]
fn unsafe_or_ambiguous_profile_bindings_are_rejected() {
    let base = serde_json::to_value(example()).unwrap();
    let invalid = [
        ("unknown", json!({"key":"F5","modifiers":[]})),
        ("saveState", json!({"key":"F4","modifiers":["Alt"]})),
        ("saveState", json!({"key":"Tab","modifiers":["Alt"]})),
        (
            "saveState",
            json!({"key":"F1","modifiers":["Shift","Shift"]}),
        ),
        ("saveState", json!({"key":"F3","modifiers":[]})),
        ("saveState", json!({"key":"F1","modifiers":["Win"]})),
    ];
    for (action, chord) in invalid {
        let mut value = base.clone();
        value["profiles"][0]["actions"][action] = chord;
        assert!(
            serde_json::from_value::<Profiles>(value)
                .unwrap()
                .validate()
                .is_err(),
            "{action}"
        );
    }
    let mut value = base.clone();
    value["profiles"][0]["actions"]
        .as_object_mut()
        .unwrap()
        .remove("saveState");
    assert!(serde_json::from_value::<Profiles>(value)
        .unwrap()
        .validate()
        .is_err());
    let mut value = base.clone();
    value["profiles"][0]["processNames"] = json!(["a.exe", "A.exe"]);
    assert!(serde_json::from_value::<Profiles>(value)
        .unwrap()
        .validate()
        .is_err());
    let mut value = base;
    value["profiles"][0]["label"] = json!("hidden\u{200b}name");
    assert!(serde_json::from_value::<Profiles>(value)
        .unwrap()
        .validate()
        .is_err());
}
#[test]
fn modifier_order_is_canonical_and_legacy_optional_controls_stay_optional() {
    let mut profiles = example();
    profiles.profiles[0]
        .actions
        .retain(|id, _| config::ACTIONS[..3].contains(&id.as_str()));
    let save = profiles.profiles[0].actions.get_mut("saveState").unwrap();
    save.modifiers = vec!["Shift".into(), "Ctrl".into()];
    let profiles = profiles.validate().unwrap();
    assert_eq!(
        profiles.profiles[0].actions["saveState"].display(),
        "Ctrl+Shift+F1"
    );
    assert_eq!(profiles.profiles[0].actions.len(), 3);
}
#[test]
fn only_assigned_private_ipv4_or_loopback_can_be_selected() {
    let assigned = vec!["192.168.1.20".into(), "8.8.8.8".into()];
    for address in ["127.0.0.1", "192.168.1.20"] {
        assert!(config::validate_host(address, &assigned).is_ok());
    }
    for address in [
        "0.0.0.0",
        "localhost",
        "::1",
        "8.8.8.8",
        "192.168.1.21",
        "169.254.1.2",
        "127.0.0.2",
        "192.168.001.20",
    ] {
        assert!(
            config::validate_host(address, &assigned).is_err(),
            "{address}"
        );
    }
}
#[test]
fn portable_paths_follow_the_executable_and_development_is_isolated() {
    let paths = DataPaths::resolve(Path::new("C:/portable/EmulatorRemote.exe"), None).unwrap();
    assert_eq!(
        paths.config,
        Path::new("C:/portable/EmulatorRemote-data/config")
    );
    assert_eq!(
        paths.browser,
        Path::new("C:/portable/EmulatorRemote-data/browser")
    );
    let development = DataPaths::resolve(
        Path::new("C:/elsewhere/debug.exe"),
        Some(Path::new("C:/project")),
    )
    .unwrap();
    assert_eq!(development.root, Path::new("C:/project/.tauri-dev-data"));
}
#[test]
fn action_schema_rejects_extras_bad_uuid_and_unknown_actions() {
    let valid = json!({"requestId":"AA000000-0000-4000-8000-000000000001","profileId":"pcsx2","action":"saveState"});
    assert_eq!(
        ActionRequest::parse(valid.clone()).unwrap().request_id,
        "aa000000-0000-4000-8000-000000000001"
    );
    for (field, value) in [
        ("requestId", json!("invalid")),
        ("requestId", json!("aa000000-0000-0000-8000-000000000001")),
        ("profileId", json!("../escape")),
        ("action", json!("launch")),
        ("extra", json!(true)),
    ] {
        let mut request = valid.clone();
        request[field] = value;
        assert!(ActionRequest::parse(request).is_err());
    }
}

#[test]
fn configuration_size_unknown_fields_and_canonical_tokens_are_checked() {
    assert!(config::valid_token(&"A".repeat(43)));
    assert!(!config::valid_token(&format!("{}B", "A".repeat(42))));
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.json");
    std::fs::write(&path, " ".repeat(65_537)).unwrap();
    assert!(config::read_json::<Value>(&path).is_err());
    let mut value = serde_json::to_value(example()).unwrap();
    value["unknown"] = json!(true);
    assert!(serde_json::from_value::<Profiles>(value).is_err());
    for password in ["short", "secret\n", "secret\u{200b}"] {
        assert!(PasswordHash::derive(password).is_err());
    }
}

#[tokio::test]
async fn slow_bodies_and_excessive_headers_are_rejected() {
    let server = server(example()).await;
    let authority = server.url.strip_prefix("http://").unwrap();
    let text = format!("POST /api/login HTTP/1.1\r\nHost: {authority}\r\nOrigin: {}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{{", server.url);
    let (status, body, _) = raw(&server.url, text.into_bytes()).await;
    assert_eq!(status, 400);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "body_timeout"
    );
    let text = format!(
        "GET / HTTP/1.1\r\nHost: {authority}\r\nX-Large: {}\r\n\r\n",
        "x".repeat(9000)
    );
    assert_eq!(raw(&server.url, text.into_bytes()).await.0, 431);
    server.close().await.unwrap();
}
#[tokio::test]
async fn phone_login_profiles_health_actions_logout_and_static_assets() {
    let mut profiles = example();
    profiles.profiles[0].actions.remove("pauseResume");
    let server = server(profiles).await;
    let url = &server.url;
    let authority = url.strip_prefix("http://").unwrap();
    let (status, bytes, headers) = raw(
        url,
        format!("GET / HTTP/1.1\r\nHost: {authority}\r\n\r\n").into_bytes(),
    )
    .await;
    assert_eq!(status, 200);
    assert!(String::from_utf8(bytes).unwrap().contains("connect-form"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("x-content-type-options: nosniff"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-security-policy:"));
    assert_eq!(
        request(url, "GET", "/api/profiles", None, None).await.0,
        401
    );
    let token = login(url).await;
    let (status, profiles) = request(url, "GET", "/api/profiles", None, Some(&token)).await;
    assert_eq!(status, 200);
    assert_eq!(profiles["defaultProfileId"], "pcsx2");
    assert!(!profiles.to_string().contains("processNames"));
    assert_eq!(
        request(url, "GET", "/api/health", None, Some(&token)).await,
        (200, json!({"ready":false,"inputAvailable":false}))
    );
    let action = json!({"requestId":"00000000-0000-4000-8000-000000000001","profileId":"pcsx2","action":"saveState"});
    let result = request(
        url,
        "POST",
        "/api/actions",
        Some(action.clone()),
        Some(&token),
    )
    .await;
    assert_eq!(result.0, 503);
    assert_eq!(result.1["code"], "input_unavailable");
    let mut optional = action.clone();
    optional["action"] = json!("pauseResume");
    assert_eq!(
        request(url, "POST", "/api/actions", Some(optional), Some(&token))
            .await
            .1["code"],
        "action_not_configured"
    );
    let mut missing = action;
    missing["profileId"] = json!("missing");
    assert_eq!(
        request(url, "POST", "/api/actions", Some(missing), Some(&token))
            .await
            .0,
        404
    );
    assert_eq!(
        request(url, "POST", "/api/logout", Some(json!({})), Some(&token))
            .await
            .0,
        200
    );
    assert_eq!(
        request(url, "GET", "/api/health", None, Some(&token))
            .await
            .0,
        401
    );
    server.close().await.unwrap();
}
#[tokio::test]
async fn host_origin_and_fetch_metadata_reject_cross_site_requests() {
    let server = server(example()).await;
    let url = &server.url;
    let authority = url.strip_prefix("http://").unwrap();
    for headers in [
        format!("Host: evil.example\r\n"),
        format!("Host: {authority}\r\nOrigin: http://evil.example\r\n"),
        format!("Host: {authority}\r\nSec-Fetch-Site: cross-site\r\n"),
        format!("Host: {authority}\r\nOrigin: {url}\r\nOrigin: {url}\r\n"),
    ] {
        let (status, _, _) =
            raw(url, format!("GET / HTTP/1.1\r\n{headers}\r\n").into_bytes()).await;
        assert_eq!(status, 403);
    }
    let (status, _, _) = raw(
        url,
        format!("POST /api/login HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 0\r\n\r\n")
            .into_bytes(),
    )
    .await;
    assert_eq!(status, 403);
    for route in [
        "/../config/server.local.json",
        "/app.js?secret",
        "/api/health?query",
    ] {
        let (status, _, _) = raw(
            url,
            format!("GET {route} HTTP/1.1\r\nHost: {authority}\r\n\r\n").into_bytes(),
        )
        .await;
        assert!(status == 404 || status == 401);
    }
    server.close().await.unwrap();
}
#[tokio::test]
async fn malformed_oversized_encoded_and_chunked_bodies_are_bounded() {
    let server = server(example()).await;
    let url = &server.url;
    let authority = url.strip_prefix("http://").unwrap();
    let token = login(url).await;
    let cases = [
        (
            "Content-Type: text/plain\r\nContent-Length: 2\r\n".to_string(),
            b"{}".to_vec(),
            415,
        ),
        (
            "Content-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n"
                .into(),
            b"{}".to_vec(),
            415,
        ),
        (
            "Content-Type: application/json\r\nContent-Length: 1\r\n".into(),
            b"{".to_vec(),
            400,
        ),
        (
            "Content-Type: application/json\r\nContent-Length: 1\r\n".into(),
            vec![0xff],
            400,
        ),
        (
            "Content-Type: application/json\r\nContent-Length: 1025\r\n".into(),
            vec![b' '; 1025],
            413,
        ),
        (
            "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n".into(),
            format!("401\r\n{}\r\n0\r\n\r\n", " ".repeat(1025)).into_bytes(),
            413,
        ),
    ];
    for (headers, body, expected) in cases {
        let mut bytes = format!("POST /api/actions HTTP/1.1\r\nHost: {authority}\r\nOrigin: {url}\r\nAuthorization: Bearer {token}\r\n{headers}\r\n").into_bytes();
        bytes.extend(body);
        assert_eq!(raw(url, bytes).await.0, expected);
    }
    server.close().await.unwrap();
}
#[tokio::test]
async fn login_throttling_and_wrong_password_are_preserved() {
    let limited = server(example()).await;
    // Invalid payloads consume attempts before hashing. This measures a burst
    // independently of debug-build scrypt speed and concurrent test load.
    for _ in 0..3 {
        assert_eq!(
            request(&limited.url, "POST", "/api/login", Some(json!({})), None)
                .await
                .0,
            400
        );
    }
    let (status, value) = request(
        &limited.url,
        "POST",
        "/api/login",
        Some(json!({"credential":"test-password"})),
        None,
    )
    .await;
    assert_eq!(status, 429);
    assert_eq!(value["code"], "login_limited");
    limited.close().await.unwrap();
    let authentication = server(example()).await;
    assert_eq!(
        request(
            &authentication.url,
            "POST",
            "/api/login",
            Some(json!({"credential":"wrong-password"})),
            None
        )
        .await
        .0,
        401
    );
    authentication.close().await.unwrap();
}
#[tokio::test]
async fn stop_closes_idle_connections_and_releases_the_listening_port() {
    let server = server(example()).await;
    let authority = server.url.strip_prefix("http://").unwrap().to_string();
    let mut slow = TcpStream::connect(&authority).await.unwrap();
    slow.write_all(b"POST /api/login HTTP/1.1\r\n")
        .await
        .unwrap();
    server.close().await.unwrap();
    let mut bytes = Vec::new();
    let _ = timeout(Duration::from_secs(2), slow.read_to_end(&mut bytes))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind(&authority).await.unwrap();
    drop(listener);
}
#[tokio::test]
async fn controller_settings_password_memory_and_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("config");
    let controller = Controller::new(directory.clone()).unwrap();
    let state = controller.state().await.unwrap();
    assert_eq!(state.host, "127.0.0.1");
    assert!(!state.password_enabled);
    assert!(controller.start().await.is_err());
    assert!(controller.running_url().await.is_err());
    assert!(controller
        .set_password("secret".into(), "different".into())
        .await
        .is_err());
    assert!(controller
        .set_password("short".into(), "short".into())
        .await
        .is_err());
    assert!(controller
        .set_network("0.0.0.0".into(), 3000)
        .await
        .is_err());
    assert!(controller.set_network("127.0.0.1".into(), 0).await.is_err());
    let state = controller
        .set_password("test-password".into(), "test-password".into())
        .await
        .unwrap();
    assert!(state.password_enabled);
    let on_disk = std::fs::read_to_string(directory.join("server.local.json")).unwrap();
    assert!(!on_disk.contains("password"));
    assert!(!on_disk.contains("hash"));
    assert!(!on_disk.contains("salt"));
    let public = serde_json::to_string(&state).unwrap();
    assert!(!public.contains("test-password"));
    assert!(!public.contains("token"));
    controller.shutdown().await.unwrap();
    assert!(!controller.state().await.unwrap().password_enabled);
    assert!(controller
        .set_network("127.0.0.1".into(), 3000)
        .await
        .is_err());
    let reopened = Controller::new(directory).unwrap();
    assert!(!reopened.state().await.unwrap().password_enabled);
}
#[tokio::test]
async fn controller_restart_rotation_and_port_collision_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let controller = Controller::new(temp.path().join("config")).unwrap();
    controller
        .set_password("test-password".into(), "test-password".into())
        .await
        .unwrap();
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = occupied.local_addr().unwrap().port();
    controller
        .set_network("127.0.0.1".into(), port)
        .await
        .unwrap();
    assert!(controller.start().await.is_err());
    assert_eq!(controller.state().await.unwrap().runtime.phase, "error");
    drop(occupied);
    let state = controller.start().await.unwrap();
    let url = state.runtime.url.unwrap();
    assert!(state.runtime.input_available);
    assert_eq!(controller.running_url().await.unwrap(), url);
    assert_eq!(controller.start().await.unwrap().runtime.phase, "running");
    let token = login(&url).await;
    controller
        .set_password("second-password".into(), "second-password".into())
        .await
        .unwrap();
    assert_eq!(controller.state().await.unwrap().runtime.phase, "stopped");
    controller.start().await.unwrap();
    assert_eq!(
        request(&url, "GET", "/api/health", None, Some(&token))
            .await
            .0,
        401
    );
    assert_eq!(
        request(
            &url,
            "POST",
            "/api/login",
            Some(json!({"credential":"test-password"})),
            None
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request(
            &url,
            "POST",
            "/api/login",
            Some(json!({"credential":"second-password"})),
            None
        )
        .await
        .0,
        200
    );
    controller.stop().await.unwrap();
    controller.stop().await.unwrap();
    controller.shutdown().await.unwrap();
}
#[tokio::test]
async fn legacy_saved_credentials_are_removed_and_existing_profiles_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("config");
    Controller::new(directory.clone()).unwrap();
    let profiles = std::fs::read(directory.join("profiles.local.json")).unwrap();
    let token = config::random_token();
    std::fs::write(
        directory.join("server.local.json"),
        json!({"host":"192.168.99.99","port":3000,"token":token,
        "password":{"salt":"00".repeat(16),"hash":"00".repeat(32)}})
        .to_string(),
    )
    .unwrap();
    let controller = Controller::new(directory.clone()).unwrap();
    assert_eq!(controller.state().await.unwrap().host, "192.168.99.99");
    assert!(controller.start().await.is_err());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(directory.join("server.local.json")).unwrap())
            .unwrap();
    assert!(saved.get("password").is_none());
    assert_ne!(saved["token"], token);
    assert_eq!(
        std::fs::read(directory.join("profiles.local.json")).unwrap(),
        profiles
    );
}
