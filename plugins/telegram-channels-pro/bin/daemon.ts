#!/usr/bin/env bun
import { main } from "../src/daemon/main";

main().catch(async (err: unknown) => {
  const errObj = err as Error;
  process.stderr.write(`daemon-core: boot fatal: ${errObj?.message ?? String(err)}\n`);
  if (errObj?.stack) process.stderr.write(errObj.stack + "\n");
  try {
    const { tryReleaseDanglingLock } = await import("../src/daemon/process-lock");
    await tryReleaseDanglingLock();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(`daemon-core: unhandledRejection: ${String(reason)}\n`);
  process.exit(1);
});
