// Per-method request/response shapes for the Telegram Bot API. We pin to the upstream 0.0.6
// compat surface — the canonical method signatures used by getUpdates, sendMessage,
// editMessageText, answerCallbackQuery, getFile, sendChatAction.

export interface SendMessageReq {
  chat_id: number | string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: unknown;
  reply_to_message_id?: number;
}

export interface SendMessageResult {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  text?: string;
}

export interface EditMessageTextReq {
  chat_id: number | string;
  message_id: number;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: unknown;
}

export interface AnswerCallbackQueryReq {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface GetFileResult {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export type ChatAction =
  | "typing"
  | "upload_photo"
  | "upload_document"
  | "find_location"
  | "record_voice"
  | "upload_voice"
  | "upload_video";

export interface GetUpdatesOpts {
  offset?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: unknown;
  callback_query?: unknown;
  [key: string]: unknown;
}

export function buildMethodUrl(apiBase: string, token: string, method: string): string {
  // Telegram API path: /bot<token>/<method>
  return `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`;
}
