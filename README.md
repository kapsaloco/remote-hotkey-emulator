# Emulator Remote

Use your phone as a Wi-Fi remote for emulator keyboard shortcuts on a Windows PC. Save and load states, switch save slots, pause or resume, and toggle fast-forward from a mobile browser.

## How it works

The PC runs the desktop app and a local web server. Your phone opens the address shown in the app, signs in with your password, and sends button presses to the PC. A Windows input helper checks that the configured emulator is in the foreground before sending its keyboard shortcut.

```text
Phone browser -> Local network -> PC server -> Windows input helper -> Emulator
```

The phone needs no app installation. The PC must stay awake, the server must remain running, and the emulator must stay focused. The remote sends shortcuts; it does not stream games or read emulator state.

## Requirements

- A Windows 10/11 x64 PC with an interactive desktop session.
- Microsoft Edge WebView2 Runtime (Evergreen) for the desktop interface.
- .NET Framework v4 runtime for the Windows input helper; .NET Framework 4.8 or later is recommended.
- An emulator with keyboard shortcuts configured. A PCSX2 example is included; other emulators can use their own profiles.
- A phone with a modern browser on the same trusted home network. A PC connected by Ethernet and a phone connected by Wi-Fi can work together.

To build or run from source, also install:

- Node.js with npm. Node 26.11.1 is the tested version; CI uses Node 26.
- Rust's stable x64 MSVC toolchain (Rust 1.90 or later).
- Microsoft C++ Build Tools with **Desktop development with C++** and the Windows SDK.
- The .NET Framework v4 C# compiler (`csc.exe`). The build looks under `%SystemRoot%\Microsoft.NET\Framework64` and `Framework`.

The portable app does not need Node.js, Rust, or build tools on the destination PC.

## Portable Windows release

After `npm ci`, run `npm run build:portable` to create:

- `release/EmulatorRemote-1.0.0-tauri-portable-x64.exe`
- `release/EmulatorRemote-1.0.0-tauri-portable-x64.zip`
- Matching checksum and build-information files.

Extract the ZIP into a writable folder and open `EmulatorRemote.exe`. The ZIP
includes instructions, license notices, build information, and the executable;
settings and browser data are excluded. The app is unsigned and may trigger an
unknown-publisher warning. See [Windows distribution](docs/WINDOWS-DISTRIBUTION.md)
for runtime requirements, measurements, and checksum details.

Measured release 1.0.0: **4.88 MB EXE** and **2.16 MB complete ZIP**, compared with
the original **110.21 MB** Electron EXE (95.58% smaller EXE). Shared WebView2 and
.NET runtimes are not bundled in those sizes.

Release settings live in `EmulatorRemote-data/` beside the EXE. Keep that folder
with the EXE when moving or updating the app. Passwords are session-only.

### Desktop implementation

The Tauri app reuses the desktop interface and phone UI, with native Rust commands
and a Rust HTTP server instead of Electron and Node. Passwords, network settings,
server start/stop, phone sign-in, profile selection, and copying the phone address
are available. The Rust dispatcher now sends configured shortcuts through the
existing Windows input helper. It preserves foreground/held-key checks, rejects
concurrent actions, and remembers request IDs to avoid duplicate input. Helper
failures and timeouts disable input until the server is stopped and restarted;
actions are never automatically retried. Electron is no longer a dependency.

Automated checks cover the desktop bridge and phone client against the Rust
server. Native window behavior and physical phone/emulator checks remain pending
in [the verification checklist](docs/TAURI-VERIFICATION.md).

`npm run build:tauri` produces the application executable under
`src-tauri/target/release/`, without creating an installer.
`npm run build:portable` also packages that executable in `release/`.
The app uses shared WebView2 and does not bundle Node, Electron, or a browser.

Building also requires the .NET Framework v4 C# compiler described above. The build
embeds `WindowsInput.exe` in the Rust executable; starting the server extracts it
to the data folder's `native/` directory and checks readiness with an invalid
request that cannot inject input. Destination PCs still need .NET Framework v4.
The helper starts without a console window and must exit before a new server can
start. If shutdown cannot be confirmed, close the application before restarting.

Development/debug builds keep settings and browser data in `.tauri-dev-data/` at
the project root. Release builds use `EmulatorRemote-data/` beside the executable,
so moving that folder with the EXE preserves settings. To try additional profiles,
stop the server and edit
`.tauri-dev-data/config/profiles.local.json`; the existing JSON schema is unchanged.

Desktop passwords and phone sessions remain in memory and must be set again after
reopening. Password/network changes stop the listener and revoke existing sessions.
The server binds only to loopback or a selected private IPv4 address assigned to
this PC. The trusted-network/plain-HTTP requirements below still apply.

Run `npm run test:desktop-ui` for frontend bridge tests and `npm run test:tauri` for
Rust configuration, authentication, controller, dispatcher, helper protocol, and
real loopback HTTP tests. These tests never send keyboard input: helper faults
use a separate non-injecting test executable, and checks of the real helper use
only deliberately invalid requests. The test fixture is excluded from the app.
The build embeds the phone assets generated by
`npm run build:web`; `npm run desktop:tauri`, `build:tauri`, and `test:tauri` generate
these automatically.

## Install and launch

Download and extract the source, or clone this repository. Open a terminal in the project folder and run:

```powershell
npm ci
npm run desktop
```

`npm run desktop` builds and launches Tauri, including the input helper. The first
launch creates settings and profiles in `.tauri-dev-data/config/`. Subsequent
launches use the same command. `npm run desktop:tauri` is an equivalent alias.

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm` in these commands. You do not need to change the system execution policy.

### Connect your phone

1. Open **Network settings** in the desktop app. Select the PC's active Wi-Fi or Ethernet IPv4 address and save. Leave the port at `3000` unless it is in use. `127.0.0.1` is for access from the PC only.
2. Enter a unique password of 6-128 characters and click **Set password**.
3. Click **Start server**, then copy the displayed address.
4. On your phone, connect to the same network and open that address in the browser. Include `http://` and the port shown by the app. Enter the password and connect.
5. Choose a profile, focus the emulator on the PC, and use the remote buttons.

The desktop password lasts for the current app session. Set it again after reopening the app. Changing the password or network settings stops the server; click **Start server** again afterward. Closing the window stops the server and input helper.

On iPhone, you can optionally use Safari's **Add to Home Screen** to make the remote easier to reopen.

## Controls

These are the bindings in the included PCSX2 example. Check them against your installed emulator's hotkey settings and test each with a physical keyboard first.

| Button | Example shortcut | Behavior |
| --- | --- | --- |
| Save state | F1 | Saves to the emulator's selected slot |
| Load state | F3 | Loads the emulator's selected slot; optional confirmation in Settings |
| Next slot | F2 | Advances the emulator's selected slot |
| Previous slot | Shift+F2 | Moves to the previous slot |
| Pause / Resume | Space | Toggles pause |
| Fast-forward | Tab | Toggles fast-forward |

Fast-forward must be bound to a **toggle**, rather than an action that requires holding a key. The app does not know whether the emulator is paused or fast-forwarding, or which slot is selected. Check the emulator's own display. "Shortcut sent" means Windows accepted the key events; it does not confirm a successful save or load. Keep normal in-game saves as well.

Open **Settings** on the phone and enable **Confirm before loading a state** to
show a confirmation before each load. It is off by default. The choice is saved
in that browser for future visits; loading a state can discard unsaved progress.

## Configure emulator profiles

Stop the server before editing `profiles.local.json` in the desktop data folder's
`config/` directory: `.tauri-dev-data/config/` during development, or
`EmulatorRemote-data/config/` beside a release EXE. It is created from
[config/profiles.example.json](config/profiles.example.json) on first launch.
Edit the local file so changes survive updates to the example.

Each profile contains:

- `id`: a unique lowercase identifier, such as `pcsx2`.
- `label`: the name shown on the phone.
- `processNames`: allowed executable filenames, such as `pcsx2-qt.exe`. Use the exact executable name from Task Manager, without a folder path.
- `actions`: shortcut bindings using a `key` and a `modifiers` array.

For example, a shortcut with no modifiers is `{ "key": "F1", "modifiers": [] }`. A modified shortcut is `{ "key": "F2", "modifiers": ["Shift"] }`.

Supported keys are `F1`-`F12`, `A`-`Z`, `0`-`9`, `Space`, and `Tab`. Modifiers are `Ctrl`, `Alt`, and `Shift`. Duplicate shortcuts in a profile, Windows-key bindings, Alt+F4, and Alt+Tab are rejected.

`saveState`, `loadState`, and `nextSlot` are required. `previousSlot`, `pauseResume`, and `fastForward` are optional; missing controls are disabled. Add more entries to the `profiles` array for other emulators and set `defaultProfileId` to an existing profile's ID. Restart the server to load changes.

Network settings are stored alongside the profiles in `server.local.json`. Use
the desktop network controls to change them. Local configuration and data folders
are ignored by Git; do not upload them with bug reports.

## Run without the desktop window

After installing dependencies, create CLI configuration and set a password:

```powershell
npm run setup
npm run setup -- --set-password
npm run build:cli
npm start
```

Setup asks for the PC's private LAN IPv4 address; pressing Enter selects `127.0.0.1` for local-only use. Open the printed address on your phone and sign in with the chosen password. Stop the server with Ctrl+C.

If an earlier CLI setup already created the configuration, skip `npm run setup`;
it refuses to overwrite existing settings. Run the password command to reset the
CLI password.

The optional Node CLI uses the repository's `config/` directory and persists a
salted password hash there. Tauri development data is separate, and its passwords
remain session-only. Avoid running two servers on the same port. Node is required
to run this optional CLI; the Tauri executable does not need Node.

## Network and session behavior

Use this app only on a trusted home network. It uses plain HTTP, so passwords and commands are not encrypted in transit. Choose a password you do not use for other accounts. Do not forward the server port from your router to the internet.

The app does not change firewall rules. If Windows asks, allow network access only on your trusted private network. Guest Wi-Fi or access-point isolation may prevent the phone from reaching the PC even when both have internet access.

Phone sign-in tokens stay in browser memory for up to 12 hours. Refreshing the page requires signing in again; restarting the server invalidates its sessions. Controls are disabled when disconnected, while the page is in the background, or while a request is pending. Actions are never automatically retried.

The input helper checks the foreground executable and rejects shortcuts while physical Ctrl, Alt, Shift, or Windows keys are held. It does not bring an emulator to the front. Run both the emulator and this app as the same ordinary Windows user; elevated emulators and locked desktops are unsupported.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Phone cannot open the page | Start the server, select the PC's active LAN address, use the displayed port, and check the private-network firewall permission. Do not use `localhost` or `127.0.0.1` on the phone. |
| Address stopped working | The PC's address may have changed. Select its current address in Network settings and restart the server. |
| Port already in use | Stop another desktop or CLI server, or select a different port. |
| Start button is disabled | Set a password for the current desktop session. |
| Foreground mismatch or rejected input | Focus the emulator, verify `processNames`, and release modifier keys. |
| Shortcut is sent but nothing happens | Check the emulator's hotkeys and selected profile. Test the same shortcut with a physical keyboard. |
| Outcome unknown | Check the emulator before continuing, then acknowledge the message on the phone. Do not repeat a save or load blindly. |
| Input helper unavailable | Check the .NET Framework runtime and reopen the app. For source builds, `npm run desktop` rebuilds the helper. After a failure or timeout, check the emulator before restarting the server. |
| Missing C# compiler | Install or enable the .NET Framework tooling that provides the v4 `csc.exe`, then rebuild. |
| Invalid configuration | Check the local JSON against the example and profile rules above. Stop the server before editing. |

## Development

```powershell
npm run typecheck
npm test
npm run build:cli
node scripts/check-input.mjs
```

These checks do not inject keyboard input. `npm test` runs the optional CLI tests,
desktop frontend tests, and Rust tests, including the compiled phone client
against a real Rust HTTP server with a recording input adapter. Native UI and
physical phone/emulator checks are tracked in
[docs/TAURI-VERIFICATION.md](docs/TAURI-VERIFICATION.md). See
[native/README.md](native/README.md) for the input protocol and real input test.

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Builds and opens the Tauri desktop app |
| `npm start` | Starts the previously built CLI server |
| `npm run build` | Builds the Tauri release executable |
| `npm run build:portable` | Builds and packages the portable EXE/ZIP with checksums |
| `npm run build:cli` | Builds the optional Node CLI, phone UI, and helper |
| `npm test` | Runs all automated checks that do not inject keyboard input |
| `npm run audit:secrets` | Checks project/history and release artifacts without printing secret values |
| `npm run build:web` | Builds the phone interface |
| `npm run build:native` | Builds only the Windows input helper |

Application artwork lives in `assets/`. The window and portable executable use
`icon.ico`; both interface headers use `icon-1024.png`. Build scripts copy the
required files into `dist/`. Remaining manual checks are tracked in
[the verification checklist](docs/TAURI-VERIFICATION.md). Generated release files
and portable user data are ignored by Git. An existing
original Electron portable EXE is preserved locally for comparison; it is not
required to build or use Tauri.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. GitHub Actions runs the automated checks on Windows when the workflow is published.

## License

[ISC](LICENSE). Third-party dependencies retain their own licenses.
