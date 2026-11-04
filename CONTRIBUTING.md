# Contributing

For a bug, include reproduction steps, expected and actual behavior, Windows
and Node.js versions, and the emulator version when relevant. Remove passwords,
tokens, local configuration, personal paths, and private network information
from logs and screenshots before sharing them.

Discuss larger changes in an issue before implementing them. Keep pull requests
focused and describe the behavior changed and how you checked it.

## Local checks

On Windows, install dependencies with `npm ci`, then run:

```powershell
npm run typecheck
npm test
npm run build:cli
node scripts/check-input.mjs
```

`npm test` includes Rust, desktop UI, phone-client/HTTP integration, and optional
Node CLI tests. Rust requires the stable MSVC toolchain and C++ Build Tools; see
the README. These commands do not inject keyboard input. For changes to actual keyboard
delivery, follow the manual checks in [native/README.md](native/README.md) and
record the device and emulator versions tested. Do not run real keyboard input
tests in CI. Record remaining manual checks in
[docs/TAURI-VERIFICATION.md](docs/TAURI-VERIFICATION.md).

Keep local settings in ignored data folders (`.tauri-dev-data/`,
`EmulatorRemote-data/`, or `config/*.local.json` for the optional CLI). Only fictional,
non-sensitive examples belong in commits. Preserve foreground-process checks,
authentication, and the rule that actions are never automatically retried.

Contributions use the project's [ISC license](LICENSE).
