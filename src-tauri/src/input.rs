use serde::Serialize;
use serde_json::Value;
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout, Command},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};

pub type InputFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub allowed_processes: Vec<String>,
    pub key: String,
    pub modifiers: Vec<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum InputError {
    Rejected(String),
    Unavailable,
}
pub trait InputAdapter: Send + Sync {
    fn available(&self) -> bool;
    fn send(&self, shortcut: Shortcut) -> InputFuture<'_, Result<(), InputError>>;
    fn close(&self) -> InputFuture<'_, Result<(), String>>;
}
pub const SAFE_REJECTIONS: [&str; 5] = [
    "foreground_mismatch",
    "foreground_changed",
    "foreground_unavailable",
    "modifier_held",
    "key_held",
];
const DEADLINE: Duration = Duration::from_secs(2);
const HELPER: &[u8] = include_bytes!("../../dist/native/WindowsInput.exe");
#[derive(Debug)]
pub struct StartError {
    pub message: String,
    pub shutdown_confirmed: bool,
}
impl From<&str> for StartError {
    fn from(message: &str) -> Self {
        Self {
            message: message.into(),
            shutdown_confirmed: true,
        }
    }
}

// The helper is embedded so distribution cannot accidentally omit it. It is
// extracted into the portable data folder, never looked up through PATH.
pub fn install_helper(root: &Path) -> Result<PathBuf, String> {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
    };
    let directory = root.join("native");
    fs::create_dir_all(&directory).map_err(|_| "Cannot create the input helper folder.")?;
    let target = directory.join("WindowsInput.exe");
    if fs::metadata(&target).is_ok_and(|metadata| metadata.len() == HELPER.len() as u64)
        && fs::read(&target).is_ok_and(|bytes| bytes == HELPER)
    {
        return Ok(target);
    }
    let temporary = directory.join(format!(
        "WindowsInput-{}.tmp",
        crate::config::random_token()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(HELPER)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_: std::io::Error| {
        "Cannot install the input helper. Close other copies and use a writable folder."
    })?;
    Ok(target)
}

struct Request {
    line: Vec<u8>,
    reply: oneshot::Sender<Result<(), InputError>>,
}
pub struct WindowsInput {
    available: Arc<AtomicBool>,
    requests: mpsc::Sender<Request>,
    stop: watch::Sender<bool>,
    worker: tokio::sync::Mutex<Option<JoinHandle<Result<(), String>>>>,
    closed: Mutex<Option<Result<(), String>>>,
}
fn reply(line: &[u8]) -> Result<(), InputError> {
    let value: Value = serde_json::from_slice(line).map_err(|_| InputError::Unavailable)?;
    let object = value.as_object().ok_or(InputError::Unavailable)?;
    match (
        object.get("status").and_then(Value::as_str),
        object.get("code").and_then(Value::as_str),
        object.len(),
    ) {
        (Some("sent"), None, 1) => Ok(()),
        (Some("error"), Some(code), 2)
            if code != "injection_failed" && code != "input_disabled" =>
        {
            Err(InputError::Rejected(code.into()))
        }
        _ => Err(InputError::Unavailable),
    }
}
// Persistent buffer makes this cancellation-safe in select!, and each copy is
// bounded before it happens (including output without a terminating newline).
async fn line(
    reader: &mut BufReader<ChildStdout>,
    buffer: &mut Vec<u8>,
) -> Result<Vec<u8>, InputError> {
    loop {
        let bytes = reader
            .fill_buf()
            .await
            .map_err(|_| InputError::Unavailable)?;
        if bytes.is_empty() {
            return Err(InputError::Unavailable);
        }
        let end = bytes.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let length = end.unwrap_or(bytes.len());
        if buffer.len() + length > 4096 {
            return Err(InputError::Unavailable);
        }
        buffer.extend_from_slice(&bytes[..length]);
        reader.consume(length);
        if end.is_some() {
            return Ok(std::mem::take(buffer));
        }
    }
}
async fn reap(child: &mut Child) -> Result<(), String> {
    let _ = child.start_kill();
    timeout(Duration::from_secs(3), child.wait())
        .await
        .map_err(|_| "Input helper did not exit. Close the application before restarting.")?
        .map(|_| ())
        .map_err(|_| "Could not confirm input helper shutdown.".into())
}
impl WindowsInput {
    pub async fn spawn(path: &Path) -> Result<Arc<Self>, StartError> {
        let mut command = Command::new(path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        Self::spawn_command(command).await
    }
    async fn spawn_command(mut command: Command) -> Result<Arc<Self>, StartError> {
        let mut child = command
            .spawn()
            .map_err(|_| "Could not start Windows input helper.")?;
        let mut stdin = child.stdin.take().ok_or("Input helper pipe unavailable.")?;
        let mut stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Input helper pipe unavailable.")?,
        );
        let mut buffer = Vec::new();
        // This deliberately invalid probe is rejected before any native key or
        // foreground checks. It confirms .NET startup and the expected protocol.
        let ready = timeout(DEADLINE, async {
            stdin
                .write_all(b"{}\n")
                .await
                .map_err(|_| InputError::Unavailable)?;
            stdin.flush().await.map_err(|_| InputError::Unavailable)?;
            let result = reply(&line(&mut stdout, &mut buffer).await?);
            if result == Err(InputError::Rejected("invalid_request".into()))
                && stdout.buffer().is_empty()
            {
                Ok(())
            } else {
                Err(InputError::Unavailable)
            }
        })
        .await;
        if !matches!(ready, Ok(Ok(()))) {
            if let Err(message) = reap(&mut child).await {
                return Err(StartError {
                    message,
                    shutdown_confirmed: false,
                });
            }
            return Err(
                "Windows input helper did not become ready. Check the .NET Framework runtime."
                    .into(),
            );
        }
        let available = Arc::new(AtomicBool::new(true));
        let live = available.clone();
        let (requests, mut received) = mpsc::channel::<Request>(1);
        let (stop, mut stopping) = watch::channel(false);
        let worker = tokio::spawn(async move {
            let mut pending = None;
            loop {
                let request = tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    _ = child.wait() => break,
                    _ = line(&mut stdout, &mut buffer) => break, // Unsolicited output is fatal.
                    request = received.recv() => match request { Some(request) => request, None => break },
                };
                if !buffer.is_empty() || !stdout.buffer().is_empty() {
                    pending = Some(request.reply);
                    break;
                }
                let result = tokio::select! {
                    biased;
                    _ = stopping.changed() => Err(InputError::Unavailable),
                    result = timeout(DEADLINE, async {
                        stdin.write_all(&request.line).await.map_err(|_| InputError::Unavailable)?;
                        stdin.flush().await.map_err(|_| InputError::Unavailable)?;
                        let result = reply(&line(&mut stdout, &mut buffer).await?);
                        if !stdout.buffer().is_empty() { return Err(InputError::Unavailable); }
                        result
                    }) => result.unwrap_or(Err(InputError::Unavailable)),
                };
                if result == Err(InputError::Unavailable) {
                    pending = Some(request.reply);
                    break;
                }
                let _ = request.reply.send(result);
            }
            live.store(false, Ordering::SeqCst);
            received.close();
            let cleanup = reap(&mut child).await;
            if let Some(reply) = pending {
                let _ = reply.send(Err(InputError::Unavailable));
            }
            while let Some(request) = received.recv().await {
                let _ = request.reply.send(Err(InputError::Unavailable));
            }
            cleanup
        });
        Ok(Arc::new(Self {
            available,
            requests,
            stop,
            worker: tokio::sync::Mutex::new(Some(worker)),
            closed: Mutex::new(None),
        }))
    }
}
impl InputAdapter for WindowsInput {
    fn available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }
    fn send(&self, shortcut: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
        Box::pin(async move {
            if !self.available() {
                return Err(InputError::Unavailable);
            }
            let mut line = serde_json::to_vec(&shortcut).map_err(|_| InputError::Unavailable)?;
            if line.len() > 4095 {
                return Err(InputError::Unavailable);
            }
            line.push(b'\n');
            let (reply, response) = oneshot::channel();
            self.requests
                .try_send(Request { line, reply })
                .map_err(|_| InputError::Unavailable)?;
            response.await.unwrap_or(Err(InputError::Unavailable))
        })
    }
    fn close(&self) -> InputFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.available.store(false, Ordering::SeqCst);
            self.stop.send_replace(true);
            let mut worker = self.worker.lock().await;
            if let Some(task) = worker.as_mut() {
                let result = task.await.unwrap_or_else(|_| {
                    Err("Input helper task failed; close the application before restarting.".into())
                });
                *self
                    .closed
                    .lock()
                    .map_err(|_| "Input shutdown state unavailable.")? = Some(result);
                *worker = None;
            }
            self.closed
                .lock()
                .map_err(|_| "Input shutdown state unavailable.")?
                .clone()
                .unwrap_or(Ok(()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shortcut() -> Shortcut {
        Shortcut {
            allowed_processes: vec!["fixture.exe".into()],
            key: "F1".into(),
            modifiers: vec![],
        }
    }
    async fn fixture(mode: &str, log: &Path) -> Arc<WindowsInput> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/native/HelperFixture.exe");
        let mut command = Command::new(path);
        command
            .arg(mode)
            .arg(log)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        WindowsInput::spawn_command(command).await.unwrap()
    }
    #[tokio::test]
    async fn embedded_real_helper_rejects_invalid_request_without_injection() {
        let directory = tempfile::tempdir().unwrap();
        let path = install_helper(directory.path()).unwrap();
        let input = WindowsInput::spawn(&path).await.unwrap();
        // Empty allowlist and unsupported key are rejected before any native input checks.
        let invalid = Shortcut {
            allowed_processes: vec![],
            key: "Delete".into(),
            modifiers: vec![],
        };
        assert_eq!(
            input.send(invalid).await,
            Err(InputError::Rejected("invalid_request".into()))
        );
        input.close().await.unwrap();
        input.close().await.unwrap();
        assert!(!input.available());
    }
    #[tokio::test]
    async fn safe_rejection_preserves_helper_and_success_protocol_is_exact() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("log");
        let input = fixture("reject", &log).await;
        assert_eq!(
            input.send(shortcut()).await,
            Err(InputError::Rejected("foreground_mismatch".into()))
        );
        assert!(input.available());
        input.close().await.unwrap();
        let input = fixture("sent", &log).await;
        assert_eq!(input.send(shortcut()).await, Ok(()));
        input.close().await.unwrap();
    }
    #[tokio::test]
    async fn malformed_oversized_partial_failure_exit_and_timeout_disable_without_retry() {
        for mode in [
            "malformed",
            "oversized",
            "extra",
            "injection_failed",
            "exit",
            "hang",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let log = directory.path().join("log");
            let input = fixture(mode, &log).await;
            assert_eq!(
                input.send(shortcut()).await,
                Err(InputError::Unavailable),
                "{mode}"
            );
            assert!(!input.available(), "{mode}");
            assert_eq!(input.send(shortcut()).await, Err(InputError::Unavailable));
            input.close().await.unwrap();
            assert_eq!(
                std::fs::read_to_string(log).unwrap().lines().count(),
                2,
                "probe plus exactly one request: {mode}"
            );
        }
    }
    #[tokio::test]
    async fn unsolicited_output_disables_idle_helper() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("log");
        let input = fixture("unsolicited", &log).await;
        timeout(Duration::from_secs(3), async {
            while input.available() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        input.close().await.unwrap();
        assert_eq!(std::fs::read_to_string(log).unwrap().lines().count(), 1);
    }
    #[test]
    fn protocol_rejects_unknown_fields_and_partial_injection() {
        for value in [
            r#"{"status":"sent","extra":true}"#,
            r#"{"status":"error","code":"key_held","extra":true}"#,
            r#"{"status":"error","code":"injection_failed"}"#,
            r#"{"status":"error","code":"input_disabled"}"#,
        ] {
            assert_eq!(reply(value.as_bytes()), Err(InputError::Unavailable));
        }
    }

    #[tokio::test]
    async fn malformed_startup_probe_is_reaped_before_returning_error() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/native/HelperFixture.exe");
        let mut command = Command::new(path);
        command
            .arg("bad-start")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        match WindowsInput::spawn_command(command).await {
            Ok(input) => {
                input.close().await.unwrap();
                panic!("malformed probe accepted");
            }
            Err(error) => assert!(error.shutdown_confirmed),
        }
    }

    #[tokio::test]
    async fn closing_during_request_and_cancelling_close_still_reaps_worker() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("log");
        let input = fixture("hang", &log).await;
        let sending = input.clone();
        let request = tokio::spawn(async move { sending.send(shortcut()).await });
        timeout(Duration::from_secs(3), async {
            loop {
                if std::fs::read_to_string(&log).is_ok_and(|lines| lines.lines().count() == 2) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let _ = timeout(Duration::ZERO, input.close()).await;
        input.close().await.unwrap();
        assert_eq!(request.await.unwrap(), Err(InputError::Unavailable));
        assert!(!input.available());
        assert_eq!(std::fs::read_to_string(log).unwrap().lines().count(), 2);
    }
}
