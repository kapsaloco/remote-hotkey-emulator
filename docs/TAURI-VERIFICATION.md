# Tauri migration verification

## Automated checks

Run `npm run typecheck` and `npm test` on Windows with Node 26.11.1, Rust's
stable MSVC toolchain, C++ Build Tools, and the .NET Framework C# compiler.

Latest check results: **90 tests passed** (42 Rust, 7 desktop frontend, 41 optional
CLI/phone tests), plus TypeScript checks and invalid-request helper checks.
The optimized native release builds successfully, starts from its distribution
folder, and stores data beside the EXE. Three navigation regression tests and
three runtime requirement tests are included. Tauri's root URL and configured
loopback development origin are allowed; unrelated pages remain blocked.
Electron is absent from the manifest, lockfile, installed dependencies, and
desktop source. The optional Node CLI remains supported separately.

Final hygiene check: no credential-pattern or known local-credential matches in
76 project text files and the checked EXE/ZIP artifacts; four Git commits were
also checked for strong credential patterns. Test password strings are fixtures.
Embedded compiler home paths were removed and the release repackaged with new
checksums. Obsolete unpacked Electron builds, builder metadata, compiled desktop
files/logs, and default smoke-test data were deleted. The original Electron EXE
and private ignored app settings were preserved. This pattern-based audit is not
a guarantee against every possible form of sensitive data.

- Rust checks cover profile validation, authentication, sessions, rate limits,
  HTTP bounds/origin checks, deduplication, helper faults, and shutdown.
- The compiled phone client runs in a DOM simulation against a real Rust HTTP
  listener with a recording input adapter. It checks sign-in, two profiles,
  canceled load confirmation, configured actions, preference storage, and logout.
  This is not a physical phone or emulator test.
- Controller checks reopen saved network settings and multiple profiles, require
  a new password after reopening, and confirm shutdown frees the listening port.
- Desktop frontend checks cover commands/forms, rejected passwords, busy states,
  clipboard command replies, and stale polling responses.
- Debug-build crypto crates are optimized so the unchanged phone client's
  three-second deadline can complete sign-in. Scrypt parameters and the Node
  compatibility vector remain unchanged and covered by tests.
- Real helper protocol checks use deliberately invalid requests only. Successful
  action and fault tests use adapters or a test executable with no injection code.
- The original Electron portable EXE is preserved. Its SHA-256 is
  `2D2E487F45463C358AE8596C7872911C0AEF11C37A25B33918186302F6B33F3F`.

## Remaining native/device checks

These are pending, not recorded as passed. The computer-use tool reports
`failed to start Node runtime: The system cannot find the path specified. (os error 3)`.
The project's Node 26.11.1 works; this failure is in the inspection tool.
Screenshots, focus restoration, clipboard
contents, and native window-close behavior could not be inspected. No physical
phone or running emulator has been tested.

1. Run `npm run desktop`. Check the window layout and controls. Set a fresh
   password, select the intended LAN address, start the server, and copy the URL.
   Paste it locally and compare it with the displayed address.
2. Minimize the app and launch the same built EXE again. Confirm that the first
   window is restored/focused and no second window or server appears.
3. On a physical phone on the same trusted network, open the displayed URL and
   sign in. Select each configured emulator profile and check its labels,
   shortcuts, and disabled optional controls.
4. In a disposable emulator session, verify one non-saving shortcut such as
   next slot, then its modifier variant. Check that a press acts once. Check
   immediate loading with confirmation off (the default), confirmation/cancellation
   with **Settings > Confirm before loading a state** enabled, preference persistence
   after refresh, focus rejection, held modifiers, pause, and fast-forward
   against that emulator's actual bindings. Keep normal in-game saves as well.
5. Change password/network settings and confirm the server stops and old phone
   sessions no longer work. Close the window normally while connected: verify
   the server and helper exit and the address stops responding. Reopen and check
   profiles/network settings persist while a new password is required.

Record Windows, phone/browser, and emulator versions plus results here when the
device checks are performed. Release size and missing-WebView2 handling are
recorded in [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).
