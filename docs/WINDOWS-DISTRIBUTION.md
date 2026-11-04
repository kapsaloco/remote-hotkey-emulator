# Portable Windows release

## Measured release 1.0.0

| Artifact | Bytes | Decimal MB |
| --- | ---: | ---: |
| Original Electron portable EXE | 110,214,909 | 110.21 |
| Tauri portable EXE | 4,875,264 | 4.88 |
| Complete portable ZIP | 2,161,593 | 2.16 |

The new EXE is **95.58% smaller**. The ZIP includes its license/notice and
instruction files. Shared WebView2 and .NET runtimes are external to these sizes.

The packaged EXE was launched from its distribution folder and created settings
beside itself. The ZIP's five-entry allowlist and archived EXE checksum were
verified. Its imports contain Windows system DLLs only, with no Node/Electron,
WebView2Loader DLL, or separate VC runtime DLL to ship. The EXE is unsigned.
All **87 automated tests** pass; missing-runtime scenarios are tested as described
below. The original Electron EXE retains its recorded SHA-256.

Release compiler paths are remapped to generic labels so local user/home paths
are not embedded in the EXE. Packaging rejects a release containing the current
builder's home path. Run `npm run audit:secrets` to check working sources, Git
history, release files and ZIP entries for known credential patterns, known local
credential values, and local home paths. Findings show locations, not values.

## Rebuild

Build on Windows x64 using the source prerequisites in the README:

```powershell
npm ci
npm run build:portable
```

This builds the optimized Tauri release and writes these separate artifacts:

- `release/EmulatorRemote-1.0.0-tauri-portable-x64.exe`: single native application EXE.
- `release/EmulatorRemote-1.0.0-tauri-portable-x64.zip`: complete portable distribution
  with `EmulatorRemote.exe`, instructions, project license, dependency notices,
  and build information.
- Matching `-SHA256SUMS.txt` and `-build.json` files record hashes and measured sizes.

Names follow `package.json`'s version. The original
`release/EmulatorRemote-1.0.0-portable-x64.exe` is never overwritten. The packager
checks that an existing Electron EXE keeps the same hash. It rejects either a
new EXE or a complete ZIP at or above 10,000,000 bytes and verifies the archived
EXE's checksum. The release uses size optimization, LTO, stripped symbols, and
embedded desktop/phone assets and Windows input helper.

## Destination PC

Use Windows 10/11 x64 with an interactive desktop session. Extract the ZIP into a
new writable folder and open `EmulatorRemote.exe`. No Node.js, Rust, C# compiler,
application installer, or separate input-helper file is needed on that PC.

The application depends on these shared Windows components, which are not counted
in the portable download size:

- Microsoft Edge WebView2 Runtime, Evergreen distribution. Download it from
  [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).
- Microsoft .NET Framework v4 runtime for the C# input helper. .NET Framework 4.8
  or later is recommended on Windows 10/11.

WebView2 is checked before window creation. If missing or not detectable, a native
Windows message explains how to install it, and the application exits without
opening a listener. No runtime is downloaded automatically. Tauri's installer
bootstrapper options do not apply to this standalone portable EXE; the build does
not produce an installer. See [Tauri's distribution options](https://v2.tauri.app/distribute/windows-installer/)
and [Microsoft's WebView2 deployment guidance](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).

Missing-runtime detection/recovery text is unit tested with absent/invalid version
results; installed-runtime detection is exercised on this PC. A clean Windows
machine without WebView2 has not been tested, and the system runtime was not
uninstalled or altered for testing.

The app is unsigned; an unknown-publisher warning may appear. The build does not
publish or upload anything.

## Data and updates

The app creates `EmulatorRemote-data/` beside the EXE. Profiles/network settings
live under `config/`, browser data under `browser/`, and the extracted helper under
`native/`. Keep that folder with the EXE when moving the app. Passwords remain
session-only. Close the app before replacing its EXE or editing profiles.

Development settings in `.tauri-dev-data/` are separate and are never packaged.
The ZIP uses an explicit five-file allowlist, excluding all settings, passwords,
browser data, development files, and test fixtures. Dependency declarations and
available license/notice texts are collected from the production/build dependency
graph; test-only dependencies are excluded.

Native UI/physical phone/emulator checks remain recorded separately in
[TAURI-VERIFICATION.md](TAURI-VERIFICATION.md).
