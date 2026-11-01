import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateProfiles } = require('../dist/server/config.js');
const file = new URL('../config/profiles.local.json', import.meta.url);
const config = JSON.parse(readFileSync(file, 'utf8'));
validateProfiles(config);
let added = 0;
for (const profile of config.profiles) {
  if (profile.id !== 'pcsx2') continue;
  for (const [id, chord] of Object.entries({
    previousSlot: { key: 'F2', modifiers: ['Shift'] },
    pauseResume: { key: 'Space', modifiers: [] },
    fastForward: { key: 'Tab', modifiers: [] },
  })) {
    if (Object.hasOwn(profile.actions, id)) continue;
    profile.actions[id] = chord;
    added++;
  }
}
// Validation, including duplicate-chord checks, happens before modifying the file.
validateProfiles(config);
if (added) writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`Added ${added} optional PCSX2 controls. Verify Shift+F2, Space, and Tab in PCSX2 Hotkeys. Existing bindings were preserved.`);
