// ═══ Core domain types ═══

export interface UserProfile {
  id: string;
  user_id: string;
  display_name: string | null;
  green_api_id: string | null;
  green_api_token: string | null;
  green_api_url: string;
  created_at: string;
}

export interface Chat {
  id: string;
  chatId: string;
  name: string;
  type: "chat" | "group";
  preview: string;
  timestamp: number;
  avatarUrl: string | null;
  unreadCount?: number;
}

export interface ChatMessage {
  idMessage: string;
  type: "incoming" | "outgoing";
  typeMessage: string;
  textMessage?: string;
  caption?: string;
  fileName?: string;
  timestamp: number;
  senderName?: string;
  chatId?: string;
}

export interface Broadcast {
  id: number;
  created_at: string;
  message: string;
  total: number;
  sent: number;
  not_found: number;
  failed: number;
  status: "running" | "done" | "cancelled";
  file_url?: string;
  file_name?: string;
  use_typing: boolean;
}

export interface Recipient {
  id: number;
  broadcast_id: number;
  phone: string;
  status: "sent" | "not_found" | "error";
  message_id?: string;
  delivery_status: string;
  sent_at?: string;
}

export interface Template {
  id: number;
  user_id: string;
  name: string;
  text: string;
  created_at: string;
}

export interface IncomingMessage {
  id: number;
  sender: string;
  sender_name?: string;
  message: string;
  type: string;
  file_url?: string;
  received_at: string;
  is_read: boolean;
}

export interface ContactCache {
  chat_id: string;
  name: string | null;
  avatar_url: string | null;
  updated_at: number;
}

export interface InstanceStatus {
  state: string;
  stats: {
    total: number;
    sent: number;
    not_found: number;
    failed: number;
    success_rate: number;
  };
  broadcast_active: boolean;
  unread_count: number;
}

export interface GroupParticipant {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface GroupData {
  groupId: string;
  groupName: string;
  owner: string;
  participants: GroupParticipant[];
}

// ═══ API response types ═══

export interface ApiError {
  error: string;
}

export type ApiResult<T> = { data: T; error: null } | { data: null; error: string };
