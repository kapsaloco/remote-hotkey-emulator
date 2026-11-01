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
npm run build
node scripts/check-input.mjs
```

These commands do not inject keyboard input. For changes to actual keyboard
delivery, follow the manual checks in [native/README.md](native/README.md) and
record the device and emulator versions tested. Do not run real keyboard input
tests in CI.

Keep local settings in ignored `config/*.local.json` files. Only fictional,
non-sensitive examples belong in commits. Preserve foreground-process checks,
authentication, and the rule that actions are never automatically retried.

Contributions use the project's [ISC license](LICENSE).
