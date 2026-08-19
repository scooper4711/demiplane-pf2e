import type { ChildProcess } from "child_process";

export default async function globalTeardown(): Promise<void> {
  const foundryProcess = (globalThis as Record<string, unknown>)
    .__FOUNDRY_PROCESS__ as ChildProcess | undefined;

  if (foundryProcess && !foundryProcess.killed) {
    console.log("Stopping Foundry VTT...");
    foundryProcess.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        foundryProcess.kill("SIGKILL");
        resolve();
      }, 5000);

      foundryProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log("Foundry VTT stopped.");
  }
}
