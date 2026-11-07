import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    account: { type: 'string', multiple: true },
    instance: { type: 'string', multiple: true },
    'server-name': { type: 'string', default: 'aas-router.local' },
    openssl: { type: 'string', default: 'openssl' },
  },
});
const { output, account, instance, 'server-name': serverName, openssl } = values;

function checkAliases(list) {
  return list?.length && list.every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
    && new Set(list.map(id => id.toLowerCase())).size === list.length;
}
if (!output || !checkAliases(account) || !checkAliases(instance)
  || !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(serverName)) {
  throw new Error('Usage: node tools/new-local-certificates.mjs --output <new-private-directory> --account <id> --instance <id> [repeat --account and --instance] [--server-name <DNS-name>] [--openssl <path>]');
}
function run(...args) {
  const result = spawnSync(openssl, args, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) throw new Error('OpenSSL failed: ' + args[0] + '. Check the executable and protected output location.');
}
run('version');
process.umask(0o077);
const target = resolve(output);
mkdirSync(target, { mode: 0o700 });
const admin = join(target, 'ca-admin');
mkdirSync(admin, { mode: 0o700 });
const caKey = join(admin, 'ca.key.pem');
const ca = join(admin, 'ca.cert.pem');
run('req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
  '-days', '730', '-subj', '/CN=AAS deployment CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  '-keyout', caKey, '-out', ca);

function leaf(role, alias, usage, san) {
  const pki = join(target, alias, 'pki');
  mkdirSync(pki, { recursive: true, mode: 0o700 });
  const key = join(pki, role + '.key.pem');
  const cert = join(pki, role + '.cert.pem');
  const csr = join(admin, alias + '.csr');
  const ext = join(admin, alias + '.ext');
  const extensions = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=' + usage];
  if (san) extensions.push('subjectAltName=DNS:' + san);
  writeFileSync(ext, extensions.join('\n') + '\n', { mode: 0o600 });
  run('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', '/CN=' + (san ?? alias), '-keyout', key, '-out', csr);
  run('x509', '-req', '-days', '365', '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-in', csr, '-extfile', ext, '-out', cert);
  copyFileSync(ca, join(pki, 'ca.cert.pem'));
  return new X509Certificate(readFileSync(cert)).fingerprint256;
}
const pins = {
  serverName,
  router: leaf('router', 'router', 'serverAuth', serverName),
  workers: Object.fromEntries(account.map(id => [id, leaf('worker', 'worker-' + id, 'clientAuth')])),
  ingress: Object.fromEntries(instance.map(id => [id, leaf('ingress', 'ingress-' + id, 'clientAuth')])),
};
writeFileSync(join(target, 'fingerprints.json'), JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
process.stdout.write('Created deployment certificate bundles. Keep ca-admin offline; distribute only the matching role bundle.\n');
