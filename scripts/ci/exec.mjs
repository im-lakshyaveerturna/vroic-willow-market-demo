/**
 * Bounded child-process capture. Output is read into memory (never inherited),
 * so a caller can emit sanitized codes/evidence without leaking raw stdout,
 * stderr, connection URIs or customer data.
 */
import { execFileSync } from 'node:child_process'

const MAX_BUFFER = 1024 * 1024

export function runCaptured(file, args, options = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      env: options.env ?? process.env,
      ...(options.input !== undefined ? { input: options.input } : {}),
    })
    return { ok: true, code: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    const code = typeof error.status === 'number' ? error.status : 1
    const stdout = error.stdout ? String(error.stdout).slice(0, MAX_BUFFER) : ''
    const stderr = error.stderr ? String(error.stderr).slice(0, MAX_BUFFER) : ''
    return { ok: false, code, stdout, stderr }
  }
}
