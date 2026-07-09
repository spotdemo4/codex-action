import * as exec from "@actions/exec";

export type ProcessOptions = exec.ExecOptions;

export async function runCapturedProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const output = await exec.getExecOutput(command, args, {
    ...options,
    silent: options.silent ?? true,
  });

  return { stdout: output.stdout, stderr: output.stderr };
}

export async function runInheritedProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<void> {
  await exec.exec(command, args, options);
}
