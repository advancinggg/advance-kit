/**
 * AdminChatRegistry — M005-internal helper resolving "the admin chat" for outbound
 * messages from M004's `request_approval` and M008's AlertDispatcher.
 *
 * Lifecycle: in-memory only; lost on daemon restart. User must DM the bot once
 * (private chat) after restart, OR set TG_ADMIN_CHAT_ID env, OR `request_approval`
 * returns NoAdminChatConfigured.
 *
 * Privacy filter: `setFromInbound` only accepts `chat_type === 'private'` —
 * group/channel chats are silently skipped to prevent privilege leak (approval
 * prompts visible to non-admins).
 */
export type AdminChatSubscriber = (chatId: number | null) => void;

export class AdminChatRegistry {
  private chatId: number | null = null;
  private subscribers: AdminChatSubscriber[] = [];

  constructor(envValue: string | undefined) {
    if (envValue !== undefined && envValue.trim().length > 0) {
      const parsed = Number(envValue.trim());
      // SECURITY (adversarial R1 #5): TG private chat IDs are POSITIVE
      // integers; group/supergroup IDs are NEGATIVE. The setFromInbound
      // path filters chat_type==='private' but the env path needs an
      // analogous guard or attackers can set a group chat ID and have
      // request_approval prompts (with potentially sensitive context)
      // delivered to the entire group.
      if (Number.isInteger(parsed) && parsed > 0) {
        this.chatId = parsed;
      } else if (Number.isInteger(parsed)) {
        process.stderr.write(
          `AdminChatRegistry: TG_ADMIN_CHAT_ID=${parsed} rejected (negative/zero chat ID indicates group/channel; only positive private chat IDs accepted)\n`,
        );
      }
      // Malformed env (non-integer) → silently ignored at boot
    }
  }

  /**
   * Capture admin chat from inbound TG update. Filtered to private chats only.
   * Called by M005 InboundDispatcher after admin gate verification.
   */
  setFromInbound(chatId: number, chatType: string): void {
    if (chatType !== "private") return;
    if (this.chatId === chatId) return;
    this.chatId = chatId;
    for (const cb of this.subscribers) cb(chatId);
  }

  /**
   * @internal Test-only: seed the registry directly with a positive chat ID
   * (no chat-type filter; only positive integers accepted to mirror env path
   * adversarial R1 #5 guard). Production code MUST NOT call this — production
   * uses `setFromInbound` (with `chat.type === 'private'` filter) or the
   * constructor-env path.
   */
  setFromEnvForTest(chatId: number): void {
    if (!Number.isInteger(chatId) || chatId <= 0) {
      throw new Error(`setFromEnvForTest: chatId must be a positive integer, got ${chatId}`);
    }
    if (this.chatId === chatId) return;
    this.chatId = chatId;
    for (const cb of this.subscribers) cb(chatId);
  }

  get(): number | null {
    return this.chatId;
  }

  /**
   * Subscribe to chat-id changes. Fires immediately with current value if
   * non-null (avoids subscriber-startup race per CCD-20).
   */
  subscribe(callback: AdminChatSubscriber): () => void {
    this.subscribers.push(callback);
    if (this.chatId !== null) callback(this.chatId);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }
}
