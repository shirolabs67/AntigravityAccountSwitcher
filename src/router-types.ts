export type JsonObject = Record<string, unknown>;

export interface RouterConfig {
  accounts: readonly string[];
  instances: Record<string, { mcpPort: number }>;
  modelGroups: Record<string, string>;
  threshold?: number;
  exhaustedMessage?: string;
}

export interface WorkerDirectory {
  probe(accountId: string, groupId: string): Promise<{ weekly: number; fiveHour: number }>;
  open(accountId: string): Promise<WorkerStream>;
}

export interface WorkerStream {
  send(frame: JsonObject): void;
  onFrame(listener: (frame: JsonObject) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface RouterConnection {
  receive(frame: JsonObject): Promise<void>;
  close(): void;
}
