#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use emulator_remote::{
    config::DataPaths,
    controller::{Controller, DesktopState},
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, RunEvent, State, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Serialize)]
struct CommandError {
    message: String,
    unavailable: bool,
}
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self {
            message,
            unavailable: false,
        }
    }
}
#[derive(Default)]
struct ExitState {
    started: AtomicBool,
    complete: AtomicBool,
}

#[tauri::command]
async fn remote_state(
    controller: State<'_, Arc<Controller>>,
) -> Result<DesktopState, CommandError> {
    controller.state().await.map_err(Into::into)
}
#[tauri::command]
async fn remote_start(
    controller: State<'_, Arc<Controller>>,
) -> Result<DesktopState, CommandError> {
    controller.start().await.map_err(Into::into)
}
#[tauri::command]
async fn remote_stop(controller: State<'_, Arc<Controller>>) -> Result<DesktopState, CommandError> {
    controller.stop().await.map_err(Into::into)
}
#[tauri::command]
async fn remote_password(
    password: String,
    confirmation: String,
    controller: State<'_, Arc<Controller>>,
) -> Result<DesktopState, CommandError> {
    controller
        .set_password(password, confirmation)
        .await
        .map_err(Into::into)
}
#[tauri::command]
async fn remote_network(
    host: String,
    port: u16,
    controller: State<'_, Arc<Controller>>,
) -> Result<DesktopState, CommandError> {
    controller.set_network(host, port).await.map_err(Into::into)
}
#[tauri::command]
async fn remote_copy_url(
    app: tauri::AppHandle,
    controller: State<'_, Arc<Controller>>,
) -> Result<(), CommandError> {
    let url = controller.running_url().await?;
    app.clipboard()
        .write_text(url)
        .map_err(|_| CommandError::from("Could not copy the phone address.".to_string()))
}

fn main() {
    if let Err(message) =
        emulator_remote::requirements::check_webview(tauri::webview_version().ok().as_deref())
    {
        emulator_remote::requirements::show_startup_error(message);
        std::process::exit(1);
    }
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ExitState::default())
        .invoke_handler(tauri::generate_handler![
            remote_state,
            remote_start,
            remote_stop,
            remote_password,
            remote_network,
            remote_copy_url
        ])
        .setup(|app| {
            let executable = std::env::current_exe()?;
            #[cfg(debug_assertions)]
            let paths = DataPaths::resolve(&executable, std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent())?;
            #[cfg(not(debug_assertions))]
            let paths = DataPaths::resolve(&executable, None)?;
            let controller = Arc::new(Controller::new(paths.config)?);
            std::fs::create_dir_all(&paths.browser)?;
            app.manage(controller);
            let development_url = if tauri::is_dev() {
                app.config().build.dev_url.clone()
            } else {
                None
            };
            let config = &app.config().app.windows[0];
            WebviewWindowBuilder::from_config(app, config)?
                .data_directory(paths.browser)
                .devtools(cfg!(debug_assertions))
                .on_navigation(move |url| {
                    emulator_remote::navigation::allowed(url, development_url.as_ref())
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            eprintln!("Desktop startup failed: {error}");
            emulator_remote::requirements::show_startup_error("Emulator Remote could not open its desktop interface.\n\nMove the app to a writable folder and ensure Microsoft Edge WebView2 Runtime is installed, then try again.");
            std::process::exit(1);
        }
    };
    application.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let exit = app.state::<ExitState>();
            if exit.complete.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            if !exit.started.swap(true, Ordering::SeqCst) {
                let controller = app.state::<Arc<Controller>>().inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if controller.shutdown().await.is_err() {
                        eprintln!("Server shutdown failed; application is closing.");
                    }
                    app.state::<ExitState>()
                        .complete
                        .store(true, Ordering::SeqCst);
                    app.exit(0);
                });
            }
        }
    });
}
