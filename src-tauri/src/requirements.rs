pub const MISSING_WEBVIEW: &str = "Emulator Remote needs Microsoft Edge WebView2 Runtime.\n\nInstall the Evergreen Runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\nThen open Emulator Remote again. The portable app does not install or download the runtime automatically.";

pub fn check_webview(version: Option<&str>) -> Result<(), &'static str> {
    if version
        .and_then(|value| value.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major > 0)
    {
        Ok(())
    } else {
        Err(MISSING_WEBVIEW)
    }
}

pub fn show_startup_error(message: &str) {
    eprintln!("{message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let title: Vec<u16> = "Cannot open Emulator Remote"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        // Both UTF-16 strings are NUL-terminated and live until the modal returns.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn present_runtime_passes_without_an_installer() {
        assert_eq!(check_webview(Some("156.0.4314.58")), Ok(()));
    }
    #[test]
    fn missing_or_invalid_runtime_explains_recovery_before_window_creation() {
        for version in [None, Some(""), Some("0.0.0.0"), Some("invalid")] {
            let message = check_webview(version).unwrap_err();
            assert!(message.contains("Evergreen"));
            assert!(message.contains("https://developer.microsoft.com/"));
        }
    }
    #[test]
    fn installed_windows_runtime_is_detectable() {
        assert!(check_webview(tauri::webview_version().ok().as_deref()).is_ok());
    }
}
