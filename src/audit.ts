import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.js";

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

export class JsonlAuditLogger implements AuditSink {
  constructor(public readonly path: string) {}

  async write(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export class NoopAuditLogger implements AuditSink {
  async write(): Promise<void> {}
}
