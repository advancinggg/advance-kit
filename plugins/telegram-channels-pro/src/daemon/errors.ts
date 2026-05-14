export class E_STATE_DIR_PERMS extends Error {
  readonly code = "E_STATE_DIR_PERMS" as const;
  constructor(public path: string, public observedMode: number, public expectedMode: number, public ownerUid: number, public selfUid: number) {
    super(
      `state dir ${path} has unexpected perms (mode=${observedMode.toString(8)} expected=${expectedMode.toString(8)}) ` +
        `and owner uid ${ownerUid} does not match process uid ${selfUid}; refusing to operate`,
    );
    this.name = "E_STATE_DIR_PERMS";
  }
}

export class E_LOCK_HELD_LIVE extends Error {
  readonly code = "E_LOCK_HELD_LIVE" as const;
  constructor(public livePid: number) {
    super(`daemon lock held by live daemon (pid=${livePid})`);
    this.name = "E_LOCK_HELD_LIVE";
  }
}

export class E_LOCK_HELD_WRONG_BINARY extends Error {
  readonly code = "E_LOCK_HELD_WRONG_BINARY" as const;
  constructor(public livePid: number, public observedCommand: string) {
    super(`daemon lock held by live but non-daemon process pid=${livePid} (command="${observedCommand}"); refusing to take over`);
    this.name = "E_LOCK_HELD_WRONG_BINARY";
  }
}

export class E_LOCK_RETRY extends Error {
  readonly code = "E_LOCK_RETRY" as const;
  constructor(public attempts: number) {
    super(`failed to acquire daemon lock after ${attempts} attempts`);
    this.name = "E_LOCK_RETRY";
  }
}

export class E_BUN_VERSION extends Error {
  readonly code = "E_BUN_VERSION" as const;
  constructor(public observed: string, public minimum: string) {
    super(`Bun version ${observed} is below required minimum ${minimum}`);
    this.name = "E_BUN_VERSION";
  }
}

export class E_HOMEDIR extends Error {
  readonly code = "E_HOMEDIR" as const;
  constructor() {
    super("os.homedir() returned empty / inaccessible value; cannot resolve state dir");
    this.name = "E_HOMEDIR";
  }
}

export class E_BOT_TOKEN_MISSING extends Error {
  readonly code = "E_BOT_TOKEN_MISSING" as const;
  constructor() {
    super("TELEGRAM_BOT_TOKEN env var is required but not set");
    this.name = "E_BOT_TOKEN_MISSING";
  }
}
