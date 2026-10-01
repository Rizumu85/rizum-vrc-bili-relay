// Windows clipboard adapter. Windows PowerShell 5.1 encodes redirected stdio
// with the legacy OEM code page by default, and clip.exe decodes piped bytes
// the same way, so both directions pin UTF-8 explicitly. Chinese titles and
// non-ASCII URLs then survive a round trip unchanged.
const CLIPBOARD_TIMEOUT_MS = 5_000;
const UTF8_WITHOUT_BOM = "[Text.UTF8Encoding]::new($false)";
const READ_SCRIPT = `[Console]::OutputEncoding=${UTF8_WITHOUT_BOM}; Get-Clipboard -Raw`;
const WRITE_SCRIPT =
  `[Console]::InputEncoding=${UTF8_WITHOUT_BOM}; `
  + "try { $in=[Console]::In.ReadToEnd(); Set-Clipboard -Value $in -ErrorAction Stop; exit 0 } catch { exit 1 }";

function powershell(script: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
}

/** Returns the trimmed clipboard text, or "" when it cannot be read. */
export async function readClipboard(): Promise<string> {
  try {
    const child = Bun.spawn(powershell(READ_SCRIPT), {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      timeout: CLIPBOARD_TIMEOUT_MS,
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    return output.trim();
  } catch {
    return "";
  }
}

/** Resolves true only when PowerShell confirmed the clipboard write. */
export async function writeClipboard(value: string): Promise<boolean> {
  try {
    const child = Bun.spawn(powershell(WRITE_SCRIPT), {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
      timeout: CLIPBOARD_TIMEOUT_MS,
    });
    child.stdin.write(value);
    child.stdin.end();
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
