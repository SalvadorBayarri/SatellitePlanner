import { spawn } from 'child_process';
import path from 'path';

const natsBin = path.resolve('.tools/nats-server-v2.10.24-windows-amd64/nats-server.exe');
const nodeBin = process.execPath;

console.log('[Stack Runner] Starting NATS Server (-js)...');
const natsProc = spawn(natsBin, ['-js', '-m', '8222', '-sd', './nats-data'], {
  stdio: 'inherit',
});

setTimeout(() => {
  console.log('[Stack Runner] Starting Backend API on http://localhost:3001...');
  const backendProc = spawn(nodeBin, ['backend/dist/index.js'], {
    stdio: 'inherit',
  });

  console.log('[Stack Runner] Starting Frontend Vite Server on http://localhost:5173...');
  const viteProc = spawn(
    nodeBin,
    ['node_modules/vite/bin/vite.js', '--port', '5173', '--host'],
    {
      cwd: path.resolve('frontend'),
      stdio: 'inherit',
    }
  );

  const shutdown = () => {
    viteProc.kill();
    backendProc.kill();
    natsProc.kill();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}, 1500);
