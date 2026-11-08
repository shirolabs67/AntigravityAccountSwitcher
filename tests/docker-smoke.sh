#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(mktemp -d)
export AAS_CONFIG_DIR="$workspace/config" AAS_SSH_BIND=127.0.0.1 AAS_SSH_PORT=23832
export COMPOSE_PROJECT_NAME="aas-smoke-$$"
http_pid=
tunnel_pid=

cleanup() {
    if [ -n "$tunnel_pid" ]; then kill "$tunnel_pid" 2>/dev/null || true; fi
    if [ -n "$http_pid" ]; then kill "$http_pid" 2>/dev/null || true; fi
    docker compose down --volumes || true
    rm -rf -- "$workspace"
}
trap cleanup EXIT

node tools/new-local-certificates.mjs --output "$workspace/certs" \
    --account account-a --account account-b --instance dsh-a --instance dsh-b
mkdir -p "$AAS_CONFIG_DIR/ssh/dsh-a" "$AAS_CONFIG_DIR/ssh/dsh-b"
cp -R "$workspace/certs/router" "$workspace/certs/worker-account-a" \
    "$workspace/certs/worker-account-b" "$AAS_CONFIG_DIR/"
for instance in dsh-a dsh-b; do
    ssh-keygen -q -t ed25519 -N '' -f "$workspace/$instance"
    cp "$workspace/$instance.pub" "$AAS_CONFIG_DIR/ssh/$instance/authorized_keys"
    cp -R "$workspace/certs/ingress-$instance/pki" "$AAS_CONFIG_DIR/ssh/$instance/"
done

node --input-type=module - "$workspace" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';

const root = process.argv[2];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(`${root}/config/${path}`, JSON.stringify(value));
const pins = read(`${root}/certs/fingerprints.json`);
const sample = role => read(`examples/${role}.example.json`);
const client = config => ({
    ...config,
    tls: { ...config.tls, serverName: pins.serverName, serverFingerprint256: pins.router }
});
const router = sample('router');
router.modelGroups = { 'smoke-model': 'Gemini Models' };
for (const account of router.accounts) account.fingerprint256 = pins.workers[account.id];
for (const [id, instance] of Object.entries(router.instances)) instance.fingerprint256 = pins.ingress[id];
write('router/router.json', router);
for (const suffix of ['a', 'b']) {
    write(`ssh/dsh-${suffix}/ingress.json`, client(sample('ingress')));
    write(`worker-account-${suffix}/worker.json`, {
        ...client(sample('worker')),
        runAsUser: `aas-worker-${suffix}`,
        cwd: '/var/lib/aas/worker/workspace',
        agyPath: '/usr/local/bin/agy'
    });
}
JS

docker compose config --quiet
docker compose build
if ! docker compose up -d --wait --wait-timeout 60; then
    docker compose logs --no-color
    exit 1
fi
docker compose exec -T --user aas-worker-a worker-a agy --version | grep -F '1.5.3'
docker compose exec -T --user aas-worker-a worker-a sh -c 'echo smoke > "$HOME/worker-a-marker"'
docker compose exec -T --user aas-worker-b worker-b sh -c 'test ! -e "$HOME/worker-a-marker"'
docker compose exec -T --user dsh-a ssh sh -c '
    test -r /run/aas/dsh-a/ingress.json &&
    test ! -r /run/aas/dsh-b/ingress.json &&
    test ! -r /aas-input/config/dsh-b/pki/ingress.key.pem
'

# Trust the host key from inside the test deployment.
printf '[127.0.0.1]:%s %s\n' "$AAS_SSH_PORT" \
    "$(docker compose exec -T ssh cat /var/lib/aas/ssh/ssh_host_ed25519_key.pub)" > "$workspace/known_hosts"
ssh_options=(-F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$workspace/known_hosts" -o ExitOnForwardFailure=yes
    -o ConnectTimeout=5 -p "$AAS_SSH_PORT" -i "$workspace/dsh-a")

# The SSH session reaches the Rust router through the forced ingress and mTLS.
node --input-type=module - "${ssh_options[@]}" <<'JS'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ssh = spawn('ssh', [...process.argv.slice(2), '-T', 'dsh-a@127.0.0.1', 'ignored'], {
    stdio: ['pipe', 'pipe', 'inherit']
});
const lines = createInterface({ input: ssh.stdout });
const reply = new Promise((resolve, reject) => {
    lines.once('line', resolve);
    ssh.once('error', reject);
    ssh.once('exit', code => reject(new Error(`SSH exited before ACP reply: ${code}`)));
});
const timer = setTimeout(() => ssh.kill(), 8000);
try {
    ssh.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} }
    }) + '\n');
    const result = JSON.parse(await reply);
    if (result.id !== 1 || result.result?.protocolVersion !== 1) {
        throw new Error('ACP initialization failed');
    }
} finally {
    clearTimeout(timer);
    ssh.kill();
    lines.close();
}
JS

# A worker's 127.0.0.1 reaches the permitted reverse tunnel.
mkdir "$workspace/www"
printf 'compose callback verified\n' > "$workspace/www/probe"
python3 -m http.server --bind 127.0.0.1 --directory "$workspace/www" 23833 &
http_pid=$!
ssh "${ssh_options[@]}" -NT -R 127.0.0.1:43101:127.0.0.1:23833 dsh-a@127.0.0.1 &
tunnel_pid=$!
probe_callback() {
    docker compose exec -T --user aas-worker-a worker-a timeout 2 bash -c '
        exec 3<>/dev/tcp/127.0.0.1/43101 || exit
        printf "GET /probe HTTP/1.0\r\n\r\n" >&3
        grep -Fx "compose callback verified" <&3
    '
}
for attempt in {1..20}; do
    if probe_callback; then break; fi
    if [ "$attempt" -eq 20 ]; then exit 1; fi
    kill -0 "$tunnel_pid"
    sleep 0.5
done

if timeout 8 ssh "${ssh_options[@]}" -NT -R 127.0.0.1:43102:127.0.0.1:23833 \
    dsh-a@127.0.0.1 2>"$workspace/denied.log"; then
    printf '%s\n' 'Unexpected success binding the other DSH instance port' >&2
    exit 1
fi
grep -F 'remote port forwarding failed' "$workspace/denied.log"
