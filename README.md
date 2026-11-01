# Emulator Remote

Use your phone as a Wi-Fi remote for emulator keyboard shortcuts on a Windows PC. Save and load states, switch save slots, pause or resume, and toggle fast-forward from a mobile browser.

## How it works

The PC runs the desktop app and a local web server. Your phone opens the address shown in the app, signs in with your password, and sends button presses to the PC. A Windows input helper checks that the configured emulator is in the foreground before sending its keyboard shortcut.

```text
Phone browser -> Local network -> PC server -> Windows input helper -> Emulator
```

The phone needs no app installation. The PC must stay awake, the server must remain running, and the emulator must stay focused. The remote sends shortcuts; it does not stream games or read emulator state.

## Requirements

- A Windows PC with an interactive desktop session.
- Node.js 22.12 or later, including npm, to build and run from source.
- The .NET Framework v4 C# compiler (`csc.exe`) to build the input helper. The build looks under `%SystemRoot%\Microsoft.NET\Framework64` and `Framework`.
- An emulator with keyboard shortcuts configured. A PCSX2 example is included; other emulators can use their own profiles.
- A phone with a modern browser on the same trusted home network. A PC connected by Ethernet and a phone connected by Wi-Fi can work together.

This project currently runs from source. A downloadable installer and executable release are not yet provided.

## Install and launch

Download and extract the source, or clone this repository. Open a terminal in the project folder and run:

```powershell
npm ci
npm run build
npm run desktop
```

The first launch creates local network settings and emulator profiles. Subsequent launches only need `npm run desktop`. Run `npm run build` again after changes to the native input helper. Close the app before rebuilding a helper in use.

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
| Load state | F3 | Asks for confirmation before sending the shortcut |
| Next slot | F2 | Advances the emulator's selected slot |
| Previous slot | Shift+F2 | Moves to the previous slot |
| Pause / Resume | Space | Toggles pause |
| Fast-forward | Tab | Toggles fast-forward |

Fast-forward must be bound to a **toggle**, rather than an action that requires holding a key. The app does not know whether the emulator is paused or fast-forwarding, or which slot is selected. Check the emulator's own display. "Shortcut sent" means Windows accepted the key events; it does not confirm a successful save or load. Keep normal in-game saves as well.

## Configure emulator profiles

Stop the server before editing `config/profiles.local.json`. It is created from [config/profiles.example.json](config/profiles.example.json) on first launch. Edit the local file so your changes survive future updates to the example.

Each profile contains:

- `id`: a unique lowercase identifier, such as `pcsx2`.
- `label`: the name shown on the phone.
- `processNames`: allowed executable filenames, such as `pcsx2-qt.exe`. Use the exact executable name from Task Manager, without a folder path.
- `actions`: shortcut bindings using a `key` and a `modifiers` array.

For example, a shortcut with no modifiers is `{ "key": "F1", "modifiers": [] }`. A modified shortcut is `{ "key": "F2", "modifiers": ["Shift"] }`.

Supported keys are `F1`-`F12`, `A`-`Z`, `0`-`9`, `Space`, and `Tab`. Modifiers are `Ctrl`, `Alt`, and `Shift`. Duplicate shortcuts in a profile, Windows-key bindings, Alt+F4, and Alt+Tab are rejected.

`saveState`, `loadState`, and `nextSlot` are required. `previousSlot`, `pauseResume`, and `fastForward` are optional; missing controls are disabled. Add more entries to the `profiles` array for other emulators and set `defaultProfileId` to an existing profile's ID. Restart the server to load changes.

Network settings are stored in `config/server.local.json`. Use the desktop network controls to change them. Both local configuration files are ignored by Git; do not upload them with bug reports.

## Run without the desktop window

After installing dependencies, create CLI configuration and set a password:

```powershell
npm run setup
npm run setup -- --set-password
npm run build
npm start
```

Setup asks for the PC's private LAN IPv4 address; pressing Enter selects `127.0.0.1` for local-only use. Open the printed address on your phone and sign in with the chosen password. Stop the server with Ctrl+C.

If desktop launch or an earlier setup already created the configuration, skip `npm run setup`; it refuses to overwrite existing settings. Run the password command to set or reset the CLI password.

The CLI persists a salted password hash in local configuration. Opening the desktop app removes this saved hash and uses its own session password. To return to CLI use afterward, run `npm run setup -- --set-password` again. Run only one server at a time.

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
| Input helper unavailable | Close the app, run `npm run build`, and reopen it. After a helper failure or timeout, check the emulator and restart the server. |
| Missing C# compiler | Install or enable the .NET Framework tooling that provides the v4 `csc.exe`, then rebuild. |
| Invalid configuration | Check the local JSON against the example and profile rules above. Stop the server before editing. |

## Development

```powershell
npm run typecheck
npm test
npm run build
node scripts/check-input.mjs
```

These checks do not inject keyboard input. Tests cover configuration, authentication, HTTP endpoints, dispatching, desktop lifecycle, and browser behavior. Manual Windows and phone testing is still needed. See [native/README.md](native/README.md) for the input protocol and real keyboard input test.

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Builds the interfaces and opens the desktop app |
| `npm start` | Starts the previously built CLI server |
| `npm run build` | Builds both interfaces, server code, and native input helper |
| `npm run build:desktop` | Builds desktop and web code without rebuilding the helper |
| `npm run build:web` | Builds the phone interface |
| `npm run build:native` | Builds only the Windows input helper |

Application artwork lives in `assets/`. The desktop window uses `icon.ico`; both interface headers use `icon-1024.png`. Build scripts copy the required files into `dist/`. Future Windows executable packaging should use the same ICO.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. GitHub Actions runs the automated checks on Windows when the workflow is published.

## License

[ISC](LICENSE). Third-party dependencies retain their own licenses.
