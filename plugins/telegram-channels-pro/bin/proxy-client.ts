#!/usr/bin/env bun
import { main } from "../src/mcp/proxy-client";

main().catch((err: unknown) => {
  const errObj = err as Error;
  process.stderr.write(`proxy-client: fatal: ${errObj?.message ?? String(err)}\n`);
  if (errObj?.stack) process.stderr.write(errObj.stack + "\n");
  process.exit(1);
});
