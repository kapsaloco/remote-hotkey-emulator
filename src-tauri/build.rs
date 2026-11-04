fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "remote_state",
        "remote_start",
        "remote_stop",
        "remote_password",
        "remote_network",
        "remote_copy_url",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Tauri application resources");
}
