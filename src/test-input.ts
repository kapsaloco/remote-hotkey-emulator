import { setTimeout } from 'node:timers/promises';
import { WindowsInput } from './input/windows';

async function main(): Promise<void> {
  const [executable, key, ...modifiers] = process.argv.slice(2);
  if (!executable || !key || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(executable) ||
      !/^(F([1-9]|1[0-2])|[A-Z0-9]|Space|Tab)$/.test(key) ||
      modifiers.some(value => !['Ctrl', 'Alt', 'Shift'].includes(value)) ||
      new Set(modifiers).size !== modifiers.length) {
    throw new Error('Usage: npm run test:input -- <exact-emulator.exe> <key> [Ctrl] [Alt] [Shift]');
  }
  console.log(`In 5 seconds: ${[...modifiers, key].join('+')} to foreground ${executable}. Focus the emulator and release modifier keys.`);
  await setTimeout(5000);
  const input = new WindowsInput();
  try {
    await input.sendShortcut({ allowedProcesses: [executable], key,
      modifiers: modifiers as Array<'Ctrl' | 'Alt' | 'Shift'> });
    console.log('Shortcut sent. Verify the effect in the emulator.');
  } finally { await input.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Input test failed.');
  process.exitCode = 1;
});
