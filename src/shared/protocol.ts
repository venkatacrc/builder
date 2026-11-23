// Messages exchanged between the extension host and the chat webview.

import type { QuotaBlock } from './quota';

export type ChatStatus = 'starting' | 'idle' | 'running' | 'error' | 'stopped';

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export interface ChatInfo {
  id: string;
  title: string;
  status: ChatStatus;
  statusText?: string;
  model?: string;
  agent: string;
  cwd: string;
  autoApprove: boolean;
  pendingChanges: number;
  sessionId?: string;
}

export interface AttachmentView {
  id: string;
  kind: 'file' | 'folder' | 'selection' | 'problems' | 'image' | 'active';
  label: string;
  detail?: string;
  /** data: URL, images only (for chip thumbnail). */
  thumb?: string;
}

export type ToolStatusView = 'pending' | 'in_progress' | 'completed' | 'failed';

export type Item =
  | { id: string; kind: 'user'; text: string; attachments?: AttachmentView[] }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thought'; text: string }
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      title: string;
      toolKind: string;
      status: ToolStatusView;
      detail?: string;
      diff?: string;
      path?: string;
      line?: number;
    }
  | {
      id: string;
      kind: 'permission';
      requestId: string;
      title: string;
      options: { id: string; name: string; kind: string }[];
      resolved?: string;
    }
  | { id: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface ChatSnapshot {
  info: ChatInfo;
  items: Item[];
  models: ModelChoice[];
}

export type HostToWebview =
  | { t: 'chats'; chats: ChatInfo[]; active: string | null }
  | { t: 'snapshot'; chatId: string; snapshot: ChatSnapshot }
  | { t: 'item'; chatId: string; item: Item }
  | { t: 'append'; chatId: string; itemId: string; text: string }
  | { t: 'info'; info: ChatInfo; models?: ModelChoice[] }
  | { t: 'attachment'; attachment: AttachmentView }
  | { t: 'mentions'; reqId: number; results: AttachmentView[] }
  | { t: 'focusInput' }
  | { t: 'prefill'; text: string }
  | { t: 'trust'; trusted: boolean }
  | { t: 'quota'; quota: QuotaBlock | null };

export type WebviewToHost =
  | { t: 'ready' }
  | { t: 'send'; chatId: string; text: string; attachmentIds: string[] }
  | { t: 'cancel'; chatId: string }
  | { t: 'newChat' }
  | { t: 'setModel'; chatId: string; model: string }
  | { t: 'setAutoApprove'; chatId: string; value: boolean }
  | { t: 'permission'; chatId: string; requestId: string; optionId: string }
  | { t: 'searchMentions'; reqId: number; query: string }
  | { t: 'addImage'; name: string; mime: string; data: string }
  | { t: 'pickFile' }
  | { t: 'openFile'; path: string; line?: number }
  | { t: 'copy'; text: string }
  | { t: 'insertCode'; text: string }
  | { t: 'reviewChanges'; chatId: string }
  | { t: 'keepAll'; chatId: string }
  | { t: 'undoAll'; chatId: string }
  | { t: 'showSessions' }
  | { t: 'openInTerminal'; chatId: string }
  | { t: 'manageTrust' }
  | { t: 'dismissQuota' };
