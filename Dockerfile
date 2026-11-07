# syntax=docker/dockerfile:1
FROM rust:1.93.0-bookworm@sha256:d0a4aa3ca2e1088ac0c81690914a0d810f2eee188197034edf366ed010a2b382 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN set -eu; \
    cargo build --release --locked --bin aas; \
    mkdir /runtime-licenses; \
    rust_docs="$(rustc --print sysroot)/share/doc/rust"; \
    cp -r "$rust_docs/licenses" "$rust_docs/COPYRIGHT-library.html" /runtime-licenses/; \
    for crate in "$CARGO_HOME"/registry/src/*/*; do \
      find "$crate" -type f \( -iname 'license*' -o -iname 'licence*' -o -iname 'copying*' -o -iname 'notice*' \) \
        | while IFS= read -r license; do \
            install -D -m 0644 "$license" "/runtime-licenses/crates/${crate##*/}/${license#"$crate"/}"; \
          done; \
    done

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261107T000000Z/ bookworm main' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261107T000000Z/ bookworm-updates main' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261107T000000Z/ bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 /aas-input
COPY --from=build /build/target/release/aas /usr/local/bin/aas
COPY --from=build /runtime-licenses/ /usr/share/doc/aas/
COPY --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/aas-entrypoint

FROM runtime AS router
RUN useradd --uid 11000 --user-group --no-create-home --home-dir /nonexistent aas-router
ENTRYPOINT ["/usr/local/bin/aas-entrypoint", "router"]

FROM runtime AS ssh
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -f /etc/ssh/ssh_host_* \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 11101 --user-group --create-home --shell /bin/sh --password '*' dsh-a \
    && useradd --uid 11102 --user-group --create-home --shell /bin/sh --password '*' dsh-b
COPY deploy/docker/sshd_config /etc/ssh/aas_sshd_config
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/aas-entrypoint", "ssh"]

FROM runtime AS agy-download
ARG TARGETARCH
# Archive URLs and SHA-512 checksums from Google's linux_amd64 and linux_arm64 manifests.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=linux-x64; archive=cli_linux_x64.tar.gz; \
        sha=e363e1b17daaac2589f18e6973429c039fd5a5e5c15e9c0852fa349836f3992b10fe84732bc8d8c8208e149f0304f15aba9dec696d12efeed03917492c0580eb ;; \
      arm64) arch=linux-arm; archive=cli_linux_arm64.tar.gz; \
        sha=c2fac818b3c1bb224079df03a714ccba99728b6a3a41d86d247ab2feb8582a43840c5032f1c2b75e72667623d5503e7ffda2712c4f37b6ee19f99c3fcfb25bae ;; \
      *) echo "Unsupported agy target: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; apt-get install -y --no-install-recommends curl; \
    mkdir /agy; \
    curl --fail --silent --show-error --location --retry 3 \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.3-6604829099950080/$arch/$archive" \
      -o /tmp/agy.tar.gz; \
    printf '%s  %s\n' "$sha" /tmp/agy.tar.gz | sha512sum --check; \
    tar -xzf /tmp/agy.tar.gz -C /agy; \
    chmod 0755 /agy/antigravity

FROM runtime AS worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 11001 --user-group --no-create-home --home-dir /var/lib/aas/worker aas-worker-a \
    && useradd --uid 11002 --user-group --no-create-home --home-dir /var/lib/aas/worker aas-worker-b \
    && install -d -m 0700 /var/lib/aas/worker
COPY --from=agy-download /agy/antigravity /usr/local/bin/agy
COPY deploy/docker/dsh-bridge.md /usr/local/share/aas/dsh-bridge.md
ENV HOME=/var/lib/aas/worker AGY_CLI_DISABLE_AUTO_UPDATE=true
ENTRYPOINT ["/usr/local/bin/aas-entrypoint", "worker"]
CMD ["aas", "worker", "/run/aas/worker.json"]
