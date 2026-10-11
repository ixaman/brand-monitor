import { spawn } from 'node:child_process';
process.loadEnvFile('.env');
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', process.argv[2], 'apps/web', ...process.argv.slice(3)], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => { process.exitCode = code ?? 1; });
