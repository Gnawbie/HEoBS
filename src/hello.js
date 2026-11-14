// Windows Hello (PIN / fingerprint / face) verification.
// Electron has no built-in Windows Hello API, so this asks Windows through
// the WinRT UserConsentVerifier class, hosted in a short-lived PowerShell.
const { execFile } = require('node:child_process');
const path = require('node:path');

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
`;

function run(body) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + body],
      { windowsHide: true, timeout: 120000 },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

let availability;

/** True when this PC has Windows Hello set up (a PIN counts). */
async function available() {
  if (availability === undefined) {
    const out = await run(`
Write-Output (Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]))`);
    availability = out === 'Available';
  }
  return availability;
}

/** Shows the Windows Security prompt. Resolves true only if the user passed it. */
async function verify(message) {
  const safe = String(message).replace(/[^\w .,-]/g, '');
  const out = await run(`
Write-Output (Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${safe}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]))`);
  return out === 'Verified';
}

module.exports = { available, verify };
