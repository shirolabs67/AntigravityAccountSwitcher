#!/bin/sh
set -eu
umask 077

# Translate host bind-mount permissions into Linux per-role permissions,
# including when the source is shared from a Windows filesystem.
stage_config() {
    role=$1 source=$2 destination=$3 group=$4
    install -d -m 0750 -g "$group" "$destination" "$destination/pki"
    install -m 0640 -g "$group" "$source/$role.json" "$destination/$role.json"
    for file in "$role.key.pem" "$role.cert.pem" ca.cert.pem; do
        install -m 0640 -g "$group" "$source/pki/$file" "$destination/pki/$file"
    done
}

role=$1
shift
case "$role" in
    router)
        stage_config router /aas-input/config /run/aas aas-router
        exec setpriv --reuid=aas-router --regid=aas-router --init-groups aas serve /run/aas/router.json
        ;;
    worker)
        user=${AAS_WORKER_USER:-aas-worker-a}
        case "$user" in
            aas-worker-a|aas-worker-b) ;;
            *) printf '%s\n' 'Invalid AAS_WORKER_USER' >&2; exit 1 ;;
        esac
        stage_config worker /aas-input/config /run/aas "$user"
        chown -h "$user:$user" "$HOME"
        chmod 0700 "$HOME"
        exec setpriv --reuid="$user" --regid="$user" --init-groups \
            /usr/local/bin/aas-entrypoint worker-user "$@"
        ;;
    worker-user)
        install -d -m 0700 "$HOME/workspace" "$HOME/.gemini/config/agents"
        install -m 0600 /usr/local/share/aas/dsh-bridge.md "$HOME/.gemini/config/agents/dsh-bridge.md"
        cd "$HOME/workspace"
        exec "$@"
        ;;
    ssh)
        install -d -m 0755 /run/sshd /run/aas
        for user in dsh-a dsh-b; do
            stage_config ingress "/aas-input/config/$user" "/run/aas/$user" "$user"
            # sshd and the forced command use the same private per-user directory.
            install -m 0640 -g "$user" "/aas-input/config/$user/authorized_keys" "/run/aas/$user/authorized_keys"
        done
        install -d -m 0700 /var/lib/aas/ssh
        if [ ! -s /var/lib/aas/ssh/ssh_host_ed25519_key ]; then
            ssh-keygen -q -t ed25519 -N '' -f /var/lib/aas/ssh/ssh_host_ed25519_key
        fi
        /usr/sbin/sshd -t -f /etc/ssh/aas_sshd_config
        exec /usr/sbin/sshd -D -e -f /etc/ssh/aas_sshd_config
        ;;
    *)
        printf '%s\n' 'Invalid container role' >&2
        exit 1
        ;;
esac
