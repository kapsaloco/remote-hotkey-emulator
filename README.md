# Emulator Remote

Use your phone as a Wi-Fi remote for Windows emulator shortcuts: save/load states, switch slots, pause, and toggle fast-forward. No phone app required. The desktop app uses Tauri and Rust.

## Install

1. Download the **Tauri portable ZIP** from [Releases](https://github.com/kapsaloco/remote-hotkey-emulator/releases).
2. Extract it into a writable folder and open `EmulatorRemote.exe`.

Requires **Windows 10/11 x64**, **Microsoft Edge WebView2 Runtime**, and **.NET Framework v4** (4.8 or later recommended). No Node.js or build tools are needed to run the portable app. The app is unsigned, so Windows may show an unknown-publisher warning.

Settings live in `EmulatorRemote-data/` beside the EXE. Keep that folder when moving or updating the app. See [distribution details](docs/WINDOWS-DISTRIBUTION.md) for runtimes and checksums.

## Connect your phone

1. In the desktop app's **Network settings**, select the PC's active Wi-Fi or Ethernet IPv4 address. Keep port `3000` unless it is in use.
2. Set a unique password (6–128 characters), then click **Start server**.
3. On your phone, join the same trusted network and open the displayed `http://` address, including its port.
4. Sign in, choose an emulator profile, and keep the emulator focused on the PC.

Set a password again after reopening the app. Changing the password or network settings stops the server and revokes phone sessions; start it again afterward. Refreshing the phone page requires signing in again. Closing the desktop app stops the server.

## Controls

The included PCSX2 example uses these bindings. Match them to your emulator's hotkey settings and test them with a physical keyboard first.

| Control | Shortcut |
| --- | --- |
| Save state | F1 |
| Load state | F3 |
| Next slot | F2 |
| Previous slot | Shift+F2 |
| Pause / Resume | Space |
| Fast-forward | Tab |

Fast-forward must use a **toggle** binding. The remote cannot read the current slot or emulator state; check the emulator's display. Keep normal in-game saves too.

Load confirmation is **off by default**. Enable **Settings → Confirm before loading a state** on the phone to ask before each load. Your browser remembers the choice. Loading can discard unsaved progress.

## Emulator profiles

Stop the server, then edit `EmulatorRemote-data/config/profiles.local.json` (or `.tauri-dev-data/config/profiles.local.json` during development). Use [the example](config/profiles.example.json) as a guide, set `processNames` to the emulator's exact executable filename, and match its shortcuts. Restart the server to apply changes.

Supported keys: `F1`–`F12`, `A`–`Z`, `0`–`9`, `Space`, `Tab`; modifiers: `Ctrl`, `Alt`, `Shift`. Duplicate shortcuts, Windows-key bindings, Alt+F4, and Alt+Tab are rejected. `saveState`, `loadState`, and `nextSlot` are required; other controls are optional.

## Network and input safety

- Use a **trusted local network only**. Plain HTTP does not encrypt passwords or commands. Use a unique password and never forward the server port to the internet.
- Allow firewall access only on your private network. `127.0.0.1` works on the PC only; guest Wi-Fi may block phone access.
- Keep the emulator focused and release held modifier keys. Run both apps as the same ordinary Windows user; elevated emulators and locked desktops are unsupported.
- Actions are never automatically retried. If the outcome is unknown, check the emulator before repeating a save/load. After a helper failure, check the emulator and restart the server.

If the phone cannot connect, check the displayed address, server status, and firewall. If shortcuts do nothing, check the selected profile, executable name, and emulator hotkeys.

## Build and develop

Install Node.js/npm (tested with Node 26.11.1), Rust's stable x64 MSVC toolchain (1.90+), Microsoft C++ Build Tools with the Windows SDK, and the .NET Framework v4 C# compiler.

```powershell
npm ci
npm run desktop         # Build and launch the desktop app
npm run build:portable  # Create EXE, ZIP, and checksums in release/
npm run typecheck
npm test
npm run audit:secrets
```

The optional Node CLI uses separate settings in `config/`:

```powershell
npm run setup                       # First-time configuration
npm run setup -- --set-password
npm run build:cli
npm start
```

Automated tests do not inject keyboard input. Native window and physical phone/emulator checks remain pending in [the verification checklist](docs/TAURI-VERIFICATION.md). See [CONTRIBUTING.md](CONTRIBUTING.md) and [native/README.md](native/README.md) for further checks and input-helper details. Local settings and generated builds are ignored by Git.

## License

[ISC](LICENSE). Third-party dependencies retain their own licenses.
