import { execSync } from 'child_process';

const isWin = process.platform === 'win32';

const cmd = isWin
  ? 'powershell -Command "Get-NetTCPConnection -LocalPort 3001,5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Output stopped"'
  : "kill -9 $(lsof -ti :3001) $(lsof -ti :5173) 2>/dev/null; echo stopped";

try {
  execSync(cmd, { stdio: 'inherit' });
} catch {
  // ports already free
}
