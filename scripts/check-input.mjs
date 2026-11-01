// Safe protocol/lifecycle checks: every request is invalid and cannot inject keys.
import assert from 'node:assert/strict';
import { WindowsInput } from '../dist/input/windows.js';

const input = new WindowsInput();
try {
  const first = input.sendShortcut({ allowedProcesses: ['pcsx2-qt.exe'], key: 'Delete', modifiers: [] });
  await assert.rejects(input.sendShortcut({ allowedProcesses: [], key: 'F1', modifiers: [] }), /already in progress/);
  await assert.rejects(first, /invalid_request/);
  await assert.rejects(input.sendShortcut({ allowedProcesses: ['pcsx2-qt.exe'], key: 'F1', modifiers: ['Win'] }), /invalid_request/);
  await assert.rejects(input.sendShortcut({ allowedProcesses: ['../pcsx2.exe'], key: 'F1', modifiers: [] }), /invalid_request/);
} finally {
  await input.close();
}
await assert.rejects(input.sendShortcut({ allowedProcesses: ['pcsx2-qt.exe'], key: 'F1', modifiers: [] }), /disabled/);
console.log('Passed: invalid requests, concurrent rejection, helper shutdown, disabled-after-close.');
