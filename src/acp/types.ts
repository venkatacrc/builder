// Subset of the Agent Client Protocol wire types (camelCase JSON) that Builder uses.

export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  category?: string; // 'model' | 'mode' | ...
  type: 'select' | string;
  currentValue: string;
  options: ConfigSelectOption[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string; text: string };
    }
  | { type: 'resource_link'; uri: string; name: string };

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  content?: { type: 'text'; text: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: ToolKind;
      status?: ToolStatus;
      content?: ToolCallContent[];
      locations?: { path: string; line?: number }[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: ToolStatus;
      content?: ToolCallContent[];
      locations?: { path: string; line?: number }[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: 'available_commands_update'; availableCommands: { name: string; description?: string }[] }
  | { sessionUpdate: 'config_option_update'; configOptions: ConfigOption[] }
  | { sessionUpdate: 'plan'; entries: { content: string; status: string; priority?: string }[] }
  | { sessionUpdate: string; [k: string]: unknown };

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: ToolKind; rawInput?: unknown };
  options: PermissionOption[];
}

export type PermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };

export interface PromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: ConfigOption[];
}

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string;
  outputByteLimit?: number;
}

export interface ClientHandlers {
  onUpdate(sessionId: string, update: SessionUpdate): void;
  requestPermission(req: PermissionRequest): Promise<PermissionOutcome>;
  readTextFile?(p: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
  writeTextFile?(p: { sessionId: string; path: string; content: string }): Promise<void>;
  terminal?: {
    create(p: TerminalCreateParams): Promise<{ terminalId: string }>;
    output(p: { sessionId: string; terminalId: string }): Promise<{
      output: string;
      truncated: boolean;
      exitStatus?: { exitCode: number | null; signal: string | null };
    }>;
    waitForExit(p: { sessionId: string; terminalId: string }): Promise<{ exitCode: number | null; signal: string | null }>;
    kill(p: { sessionId: string; terminalId: string }): Promise<void>;
    release(p: { sessionId: string; terminalId: string }): Promise<void>;
  };
}
