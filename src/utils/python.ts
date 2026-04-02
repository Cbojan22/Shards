import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { access } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const VENV_PYTHON = path.join(SCRIPTS_DIR, '.venv', 'bin', 'python3');

export async function runPythonScript<T>(
  scriptName: string,
  args: Record<string, string>,
  onProgress?: (msg: string) => void
): Promise<T> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const pythonBin = await getPythonBin();

  const cliArgs: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    cliArgs.push(`--${key.replace(/_/g, '-')}`, value);
  }

  return new Promise<T>((resolve, reject) => {
    const proc = spawn(pythonBin, [scriptPath, ...cliArgs], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        stderr += msg + '\n';
        if (onProgress) {
          for (const line of msg.split('\n')) {
            if (line.trim()) onProgress(line.trim());
          }
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python script ${scriptName}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `Python script ${scriptName} exited with code ${code}\n` +
          `stderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`
        ));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(`Python script error: ${result.error}`));
          return;
        }
        resolve(result as T);
      } catch {
        reject(new Error(
          `Failed to parse JSON from ${scriptName}.\n` +
          `stdout: ${stdout.slice(0, 1000)}\nstderr: ${stderr.slice(0, 500)}`
        ));
      }
    });
  });
}

async function getPythonBin(): Promise<string> {
  try {
    await access(VENV_PYTHON);
    return VENV_PYTHON;
  } catch {
    return 'python3';
  }
}

export async function isPythonSetup(): Promise<boolean> {
  try {
    await access(VENV_PYTHON);
    return true;
  } catch {
    return false;
  }
}

export async function setupPython(): Promise<void> {
  const setupScript = path.join(SCRIPTS_DIR, 'setup.sh');
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [setupScript], {
      cwd: SCRIPTS_DIR,
      stdio: 'inherit',
    });
    proc.on('error', (err) => reject(new Error(`Setup failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`Setup script exited with code ${code}`));
      else resolve();
    });
  });
}
