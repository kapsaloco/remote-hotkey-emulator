use crate::{
    auth::PasswordHash,
    config::{self, read_json, save_json, Profiles, ServerConfig},
    http::RunningServer,
    input::{self, InputAdapter, WindowsInput},
};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex, MutexGuard, Semaphore};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub phase: String,
    pub input_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn shutdown_waits_for_pending_changes_and_rejects_new_operations() {
        let directory = tempfile::tempdir().unwrap();
        let controller = Arc::new(Controller::new(directory.path().join("config")).unwrap());
        let permits = controller.work.clone().acquire_many_owned(2).await.unwrap();
        let changing = controller.clone();
        let change = tokio::spawn(async move {
            changing
                .set_password("test-password".into(), "test-password".into())
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if controller.operation.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(controller
            .set_network("127.0.0.1".into(), 3000)
            .await
            .unwrap_err()
            .contains("progress"));
        let closing = controller.clone();
        let shutdown = tokio::spawn(async move { closing.shutdown().await });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !controller.closing.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!shutdown.is_finished());
        assert!(controller.start().await.unwrap_err().contains("closing"));
        drop(permits);
        change.await.unwrap().unwrap();
        shutdown.await.unwrap().unwrap();
        assert!(!controller.state().await.unwrap().password_enabled);
        assert!(controller.inner.lock().await.server.is_none());
    }
}
impl RuntimeStatus {
    fn stopped() -> Self {
        Self {
            phase: "stopped".into(),
            input_available: false,
            url: None,
            error: None,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub runtime: RuntimeStatus,
    pub host: String,
    pub port: u16,
    pub password_enabled: bool,
    pub addresses: Vec<String>,
}
struct Inner {
    password: Option<PasswordHash>,
    server: Option<RunningServer>,
    status: RuntimeStatus,
}
pub struct Controller {
    directory: PathBuf,
    closing: AtomicBool,
    operation: Mutex<()>,
    inner: Mutex<Inner>,
    work: Arc<Semaphore>,
    shutdown_failed: AtomicBool,
}
impl Controller {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory)
            .map_err(|_| "Cannot open settings. Move the app to a writable folder.")?;
        let profiles_file = directory.join("profiles.local.json");
        if !profiles_file.exists() {
            let example: Profiles =
                serde_json::from_str(include_str!("../../config/profiles.example.json"))
                    .map_err(|_| config::INVALID)?;
            let bytes =
                serde_json::to_vec_pretty(&example.validate()?).map_err(|_| config::INVALID)?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(profiles_file)
                .and_then(|mut file| file.write_all(&bytes))
                .map_err(|_| "Could not create local profiles.")?;
        }
        let file = directory.join("server.local.json");
        if !file.exists() {
            save_json(
                &directory,
                "server.local.json",
                &ServerConfig {
                    host: "127.0.0.1".into(),
                    port: 3000,
                    token: config::random_token(),
                    password: None,
                },
            )?;
        }
        let mut settings: ServerConfig = read_json(&file)?;
        // Display stale DHCP addresses so the user can correct them; start/save use live interfaces.
        settings.validate(std::slice::from_ref(&settings.host))?;
        if settings.password.take().is_some() {
            settings.token = config::random_token();
            save_json(&directory, "server.local.json", &settings)?;
        }
        Ok(Self {
            directory,
            closing: AtomicBool::new(false),
            operation: Mutex::new(()),
            inner: Mutex::new(Inner {
                password: None,
                server: None,
                status: RuntimeStatus::stopped(),
            }),
            work: Arc::new(Semaphore::new(2)),
            shutdown_failed: AtomicBool::new(false),
        })
    }
    fn settings(&self) -> Result<ServerConfig, String> {
        let settings: ServerConfig = read_json(&self.directory.join("server.local.json"))?;
        settings.validate(std::slice::from_ref(&settings.host))?;
        Ok(settings)
    }
    fn change(&self) -> Result<MutexGuard<'_, ()>, String> {
        if self.shutdown_failed.load(Ordering::SeqCst) {
            return Err("Input shutdown failed. Close the application before restarting.".into());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing.".into());
        }
        let guard = self
            .operation
            .try_lock()
            .map_err(|_| "Another operation is in progress. Please wait.")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing.".into());
        }
        Ok(guard)
    }
    pub async fn state(&self) -> Result<DesktopState, String> {
        let settings = self.settings()?;
        let inner = self.inner.lock().await;
        let mut status = inner.status.clone();
        if let Some(server) = &inner.server {
            status.input_available = server.input_available();
            if status.phase == "running" && !status.input_available {
                status.error = Some("Input unavailable. Check the emulator before stopping and restarting the server.".into());
            }
        }
        if inner.server.as_ref().is_some_and(RunningServer::failed) {
            status = RuntimeStatus {
                phase: "error".into(),
                input_available: false,
                url: None,
                error: Some("Server failed. Stop and restart it.".into()),
            };
        }
        Ok(DesktopState {
            runtime: status,
            host: settings.host,
            port: settings.port,
            password_enabled: inner.password.is_some(),
            addresses: config::addresses()?,
        })
    }
    pub async fn start(&self) -> Result<DesktopState, String> {
        let _operation = self.change()?;
        let settings = self.settings()?;
        settings.validate(&config::addresses()?)?;
        let profiles: Profiles = read_json(&self.directory.join("profiles.local.json"))?;
        let profiles = profiles.validate()?;
        let failed = {
            let inner = self.inner.lock().await;
            inner.server.as_ref().is_some_and(RunningServer::failed)
        };
        if failed {
            self.stop_inner().await?;
        }
        let password = {
            let mut inner = self.inner.lock().await;
            if inner.server.is_some() {
                drop(inner);
                return self.state().await;
            }
            let password = inner
                .password
                .clone()
                .ok_or("Set a password before starting the desktop server.")?;
            inner.status.phase = "starting".into();
            password
        };
        let helper = match input::install_helper(
            self.directory
                .parent()
                .ok_or("Cannot locate the input helper folder.")?,
        ) {
            Ok(path) => path,
            Err(error) => {
                self.inner.lock().await.status = RuntimeStatus {
                    phase: "error".into(),
                    input_available: false,
                    url: None,
                    error: Some(error.clone()),
                };
                return Err(error);
            }
        };
        let input = match WindowsInput::spawn(&helper).await {
            Ok(input) => input,
            Err(error) => {
                if !error.shutdown_confirmed {
                    self.shutdown_failed.store(true, Ordering::SeqCst);
                }
                self.inner.lock().await.status = RuntimeStatus {
                    phase: "error".into(),
                    input_available: false,
                    url: None,
                    error: Some(error.message.clone()),
                };
                return Err(error.message);
            }
        };
        match RunningServer::bind(
            &settings.host,
            settings.port,
            password,
            profiles,
            self.work.clone(),
            input.clone(),
        )
        .await
        {
            Ok(server) => {
                let mut inner = self.inner.lock().await;
                inner.status = RuntimeStatus {
                    phase: "running".into(),
                    input_available: server.input_available(),
                    url: Some(server.url.clone()),
                    error: None,
                };
                inner.server = Some(server);
            }
            Err(error) => {
                if input.close().await.is_err() {
                    self.shutdown_failed.store(true, Ordering::SeqCst);
                }
                self.inner.lock().await.status = RuntimeStatus {
                    phase: "error".into(),
                    input_available: false,
                    url: None,
                    error: Some(error.clone()),
                };
                return Err(error);
            }
        }
        self.state().await
    }
    async fn stop_inner(&self) -> Result<(), String> {
        let server = {
            let mut inner = self.inner.lock().await;
            inner.status.phase = "stopping".into();
            inner.status.input_available = false;
            inner.status.url = None;
            inner.server.take()
        };
        let result = match server {
            Some(server) => server.close().await,
            None => Ok(()),
        };
        let mut inner = self.inner.lock().await;
        inner.status = RuntimeStatus::stopped();
        if let Err(error) = &result {
            self.shutdown_failed.store(true, Ordering::SeqCst);
            inner.status.phase = "error".into();
            inner.status.error = Some(error.clone());
        }
        result
    }
    pub async fn stop(&self) -> Result<DesktopState, String> {
        let _operation = self.change()?;
        self.stop_inner().await?;
        self.state().await
    }
    pub async fn set_password(
        &self,
        password: String,
        confirmation: String,
    ) -> Result<DesktopState, String> {
        let password = Zeroizing::new(password);
        let confirmation = Zeroizing::new(confirmation);
        let _operation = self.change()?;
        if *password != *confirmation {
            return Err("Passwords do not match.".into());
        }
        let permit = self
            .work
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Password hashing unavailable.")?;
        let hash = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            PasswordHash::derive(&password)
        })
        .await
        .map_err(|_| "Password hashing failed.")??;
        self.stop_inner().await?;
        self.inner.lock().await.password = Some(hash);
        self.state().await
    }
    pub async fn set_network(&self, host: String, port: u16) -> Result<DesktopState, String> {
        let _operation = self.change()?;
        let mut settings = self.settings()?;
        settings.host = host;
        settings.port = port;
        // Never write credentials saved by another app/session back to disk.
        settings.password = None;
        settings.validate(&config::addresses()?)?;
        self.stop_inner().await?;
        save_json(&self.directory, "server.local.json", &settings)?;
        self.state().await
    }
    pub async fn running_url(&self) -> Result<String, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing.".into());
        }
        let inner = self.inner.lock().await;
        if inner.status.phase != "running"
            || inner.server.as_ref().is_none_or(RunningServer::failed)
        {
            return Err("Start the server before copying its address.".into());
        }
        inner
            .status
            .url
            .clone()
            .ok_or_else(|| "Server address unavailable.".into())
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::SeqCst);
        let _operation = self.operation.lock().await;
        let result = self.stop_inner().await;
        self.inner.lock().await.password = None;
        result
    }
}
