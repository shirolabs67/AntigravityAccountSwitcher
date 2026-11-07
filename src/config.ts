import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ConnectionOptions, TlsOptions } from 'node:tls';
import { checkServerIdentity } from 'node:tls';
import type { JsonObject, RouterConfig } from './router-types.js';
import { object, PeerError } from './wire.js';

export type Identity = { role: 'worker' | 'ingress'; id: string };
export type BrokerConfig = {
  port: number;
  tls: TlsOptions;
  fingerprints: Map<string, Identity>;
  routing: RouterConfig;
};
export type ClientConfig = { tls: ConnectionOptions };
export type WorkerConfig = ClientConfig & {
  runAsUser: string;
  agyPath: string;
  cwd: string;
  probeTimeoutMs?: number;
};

const invalid = (field: string): never => { throw new PeerError('invalid_' + field); };

function record(value: unknown, field: string): JsonObject {
  return object(value) ?? invalid(field);
}

function str(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return invalid(field);
  return value;
}

function port(value: unknown, field = 'port'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) return invalid(field);
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = str(value, field, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) return invalid(field);
  return result;
}

export function fingerprint(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const raw = value.replaceAll(':', '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(raw) ? raw : undefined;
}

async function pem(file: unknown, location: string, label: string): Promise<Buffer> {
  try {
    const bytes = await readFile(resolve(location, str(file, label)));
    if (bytes.length > 256 * 1024) return invalid(label);
    return bytes;
  } catch {
    return invalid(label);
  }
}

async function loadTls(raw: JsonObject, directory: string) {
  const [key, cert, ca] = await Promise.all([
    pem(raw.key, directory, 'tls_key'),
    pem(raw.cert, directory, 'tls_cert'),
    pem(raw.ca, directory, 'tls_ca'),
  ]);
  return { key, cert, ca, minVersion: 'TLSv1.3' as const };
}

async function loadConfig(path: string): Promise<{ raw: JsonObject; directory: string }> {
  const location = resolve(path);
  try {
    const bytes = await readFile(location);
    if (bytes.length > 256 * 1024) return invalid('config');
    const raw = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')), 'config');
    return { raw, directory: dirname(location) };
  } catch {
    return invalid('config');
  }
}

export async function brokerConfig(path: string): Promise<BrokerConfig> {
  const { raw, directory } = await loadConfig(path);
  const listen = port(raw.port);
  const fingerprints = new Map<string, Identity>();
  const put = (value: unknown, identity: Identity) => {
    const pin = fingerprint(value);
    if (!pin || fingerprints.has(pin)) return invalid('fingerprint');
    fingerprints.set(pin, identity);
  };
  const accounts: string[] = [];
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0 || raw.accounts.length > 20) return invalid('accounts');
  for (const value of raw.accounts) {
    const account = record(value, 'accounts');
    const id = identifier(account.id, 'account_id');
    if (accounts.includes(id)) return invalid('accounts');
    accounts.push(id);
    put(account.fingerprint256, { role: 'worker', id });
  }
  const instances: RouterConfig['instances'] = Object.create(null);
  const instanceRows = Object.entries(record(raw.instances, 'instances'));
  if (!instanceRows.length || instanceRows.length > 100) return invalid('instances');
  const ports = new Set([listen]);
  for (const [name, value] of instanceRows) {
    const id = identifier(name, 'instance_id');
    const row = record(value, 'instance');
    const mcpPort = port(row.mcpPort, 'mcp_port');
    if (ports.has(mcpPort)) return invalid('mcp_port');
    ports.add(mcpPort);
    put(row.fingerprint256, { role: 'ingress', id });
    instances[id] = { mcpPort };
  }
  const modelGroups: Record<string, string> = Object.create(null);
  const models = Object.entries(record(raw.modelGroups, 'model_groups'));
  if (!models.length || models.length > 200) return invalid('model_groups');
  for (const [name, value] of models) modelGroups[str(name, 'model_id', 160)] = str(value, 'model_group', 160);
  let threshold: number | undefined;
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1) {
      return invalid('threshold');
    }
    threshold = raw.threshold;
  }
  const exhaustedMessage = raw.exhaustedMessage === undefined ? undefined : str(raw.exhaustedMessage, 'exhausted_message', 4096);
  const tls = { ...await loadTls(record(raw.tls, 'tls'), directory), requestCert: true, rejectUnauthorized: true };
  return { port: listen, tls, fingerprints, routing: { accounts, instances, modelGroups, threshold, exhaustedMessage } };
}

async function makeClient(raw: JsonObject, directory: string): Promise<ClientConfig> {
  const t = record(raw.tls, 'tls');
  const servername = str(t.serverName, 'server_name', 255);
  const pin = fingerprint(t.serverFingerprint256);
  if (!pin) return invalid('server_fingerprint');
  return { tls: {
    ...await loadTls(t, directory),
    host: '127.0.0.1',
    port: port(raw.port),
    servername,
    rejectUnauthorized: true,
    checkServerIdentity: (name, certificate) => {
      if (fingerprint(certificate.fingerprint256) !== pin) return new PeerError('invalid_server_fingerprint');
      return checkServerIdentity(name, certificate);
    },
  } };
}

export async function ingressConfig(path: string): Promise<ClientConfig> {
  const { raw, directory } = await loadConfig(path);
  return makeClient(raw, directory);
}

export async function workerConfig(path: string): Promise<WorkerConfig> {
  const { raw, directory } = await loadConfig(path);
  if (raw.geminiDir !== undefined) throw new PeerError('remove_gemini_dir_use_service_home');
  const local = (key: string): string => resolve(directory, str(raw[key], key));
  const timeout = raw.probeTimeoutMs ?? 15_000;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) return invalid('probe_timeout');
  return {
    ...await makeClient(raw, directory),
    runAsUser: str(raw.runAsUser, 'run_as_user', 128),
    agyPath: local('agyPath'),
    cwd: local('cwd'),
    probeTimeoutMs: timeout,
  };
}
