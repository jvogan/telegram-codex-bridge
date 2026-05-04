export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramBotIdentity extends TelegramUser {
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
  supports_streaming?: boolean;
}

export interface TelegramAnimation {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface TelegramVideoNote {
  file_id: string;
  file_size?: number;
  duration?: number;
  length?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  animation?: TelegramAnimation;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramFileResult {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  ip_address?: string;
}
