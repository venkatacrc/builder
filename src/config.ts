import * as vscode from 'vscode';
import { defaultConfigDir } from './puppy/files';

const section = () => vscode.workspace.getConfiguration('builder');

export const settings = {
  get codePuppyPath(): string {
    return section().get<string>('codePuppyPath', '');
  },
  get configDir(): string {
    return defaultConfigDir(section().get<string>('configDir', '') || undefined);
  },
  get useLauncher(): boolean {
    return section().get<boolean>('useLauncher', true);
  },
  get persistModelSelection(): boolean {
    return section().get<boolean>('persistModelSelection', false);
  },
  get defaultModel(): string {
    return section().get<string>('defaultModel', '');
  },
  get agent(): string {
    return section().get<string>('agent', '').trim() || 'code-puppy';
  },
  get prewarm(): boolean {
    return section().get<boolean>('prewarm', true);
  },
  get maxAgentProcesses(): number {
    return section().get<number>('maxAgentProcesses', 4);
  },
  get idleTimeoutMinutes(): number {
    return section().get<number>('idleTimeoutMinutes', 30);
  },
  get autoApprove(): boolean {
    return section().get<boolean>('autoApprove', false);
  },
  get delegateTerminal(): boolean {
    return section().get<boolean>('delegateTerminal', true);
  },
  get includeActiveEditorContext(): boolean {
    return section().get<boolean>('includeActiveEditorContext', true);
  },
  get inlineEditModel(): string {
    return section().get<string>('inlineEdit.model', '');
  },
  get tabEnabled(): boolean {
    return section().get<boolean>('tabCompletion.enabled', false);
  },
  get tabModel(): string {
    return section().get<string>('tabCompletion.model', '');
  },
  get tabDebounceMs(): number {
    return section().get<number>('tabCompletion.debounceMs', 450);
  },
  get tabMaxPrefix(): number {
    return section().get<number>('tabCompletion.maxPrefixChars', 4000);
  },
  get tabMaxSuffix(): number {
    return section().get<number>('tabCompletion.maxSuffixChars', 1500);
  },
  get logProtocol(): boolean {
    return section().get<boolean>('log.protocol', false);
  },
};

export async function setSetting(key: string, value: unknown): Promise<void> {
  await section().update(key, value, vscode.ConfigurationTarget.Global);
}
