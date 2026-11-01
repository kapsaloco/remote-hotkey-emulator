import { RemoteServerRuntime } from './server/runtime';

async function main(): Promise<void> {
  const runtime = new RemoteServerRuntime({ log: entry => console.log(JSON.stringify(entry)) });
  const removeSignals = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
  const stop = () => {
    void runtime.stop().catch(() => {
      console.error('Shutdown failed.'); process.exitCode = 1;
    }).finally(removeSignals);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const status = await runtime.start();
    if (runtime.status.phase !== 'running') return;
    console.log(`Emulator Remote: ${status.url}`);
    if (status.passwordEnabled) console.log('Password sign-in enabled. Open the URL on your phone and enter your chosen password.');
    else {
      console.log('Private access token (do not share this console or screenshots):');
      console.log(runtime.getLegacyAccessToken());
      console.log('Choose a password with: npm run setup -- --set-password');
    }
    console.log('Stop with Ctrl+C.');
  } catch (failure) { removeSignals(); throw failure; }
}
main().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : 'Startup failed.'); process.exitCode = 1;
});
