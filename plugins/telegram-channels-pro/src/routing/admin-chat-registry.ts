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
      if (Number.isInteger(parsed)) {
        this.chatId = parsed;
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

  /** Test-only: seed the registry directly (no chat-type check). */
  setFromEnvForTest(chatId: number): void {
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
