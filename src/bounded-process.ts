export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface BoundedProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes?: number;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = Math.max(0, maxOutputBytes - retainedBytes);
      if (remaining > 0) {
        const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
        chunks.push(chunk);
        retainedBytes += chunk.byteLength;
      }
      if (value.byteLength > remaining) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return { text, truncated };
}

export async function runBoundedProcess(
  command: string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("bounded process stdin is unavailable");
    stdin.write(options.stdin);
    stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, maxOutputBytes),
      readBounded(child.stderr, maxOutputBytes),
      child.exited,
    ]);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}
