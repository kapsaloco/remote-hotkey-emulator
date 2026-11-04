# Local Windows input proof

Requires Windows and the .NET Framework v4 C# compiler (`csc.exe`). The build
detects `Framework64`, then `Framework`, beneath `%SystemRoot%\Microsoft.NET`.
The helper uses C# 5 and references the framework's `System.Web.Extensions.dll`.
Compiler 4.8.9221.0 was used for initial compilation.

Run `npm run build:cli` to compile the optional CLI TypeScript and
`dist/native/WindowsInput.exe`. The Tauri commands build and embed the helper
automatically.
`npm run build:native` rebuilds only the helper. Generated files are ignored.
`node scripts/check-input.mjs` checks invalid requests and adapter lifecycle
without injecting any keys, after a build.

To test real input, first verify the chosen shortcut with a physical keyboard
in a disposable PCSX2 session. Find the actual PCSX2 executable basename in
Task Manager. Then run, substituting that exact name and your configured key:

```powershell
npm run test:input -- pcsx2-qt.exe F2
```

You have five seconds to focus PCSX2 and release Ctrl/Alt/Shift/Win. Exactly one
shortcut is attempted; it is never retried. Optional modifiers follow the key,
for example `F2 Ctrl Shift`. Verify the effect in PCSX2; `sent` only means
Windows accepted the keyboard events. Repeat with Notepad foreground and check
that the helper rejects the action without typing anything. Do not allowlist
Notepad to perform this check. Both programs must run as the ordinary desktop
user; do not elevate the helper.

The helper accepts newline-delimited JSON on stdin:

```json
{"allowedProcesses":["pcsx2-qt.exe"],"key":"F2","modifiers":[]}
```

Each request yields `{"status":"sent"}` or
`{"status":"error","code":"foreground_mismatch"}` (other error codes describe
validation, foreground availability, held keys, and injection failure). EOF
stops it. Partial injection disables the helper; the adapter also disables input
on helper failure or a two-second timeout. Restart only after checking the
emulator because a failed or timed-out operation may already have had an effect.
Foreground checking reduces accidental input but cannot eliminate a focus-change
race. Real PCSX2, fullscreen, modifier, and partial-injection behavior still need
desktop testing; automated protocol checks do not establish those results.
