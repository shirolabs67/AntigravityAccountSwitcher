mod acp_backend;
mod broker;
mod config;
mod router;
mod wire;
mod worker;

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::broker::READY_TIMEOUT;
use crate::wire::{Peer, PeerError, read_frame, write_frame};
use crate::worker::{AccountWorker, WorkerError, validate_worker_agent};

fn profile_for(run_as_user: &str) -> Result<PathBuf, PeerError> {
    let wrong_user = || PeerError::new("wrong_worker_user");
    #[cfg(unix)]
    {
        let uid = uzers::get_effective_uid();
        if uid == 0
            || uid != uzers::get_current_uid()
            || uzers::get_user_by_uid(uid).is_none_or(|user| user.name() != run_as_user)
        {
            return Err(wrong_user());
        }
    }
    #[cfg(windows)]
    {
        let actual = whoami::fallible::username().map_err(|_| wrong_user())?;
        if actual.to_lowercase() != run_as_user.to_lowercase() {
            return Err(wrong_user());
        }
    }
    env::home_dir()
        .filter(|path| path.is_absolute())
        .map(|path| path.join(".gemini"))
        .ok_or_else(|| PeerError::new("agent_missing"))
}

fn worker_error(error: WorkerError) -> PeerError {
    PeerError::new(error.category())
}

fn handle_stream(
    runtime: &AccountWorker,
    peer: &Peer,
    method: &str,
    params: &mut Value,
) -> Result<Value, PeerError> {
    let stream_id = params["streamId"]
        .as_str()
        .filter(|id| {
            id.len() == 36
                && id
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
        })
        .ok_or_else(|| PeerError::new("invalid_stream_id"))?
        .to_owned();
    match method {
        "worker/open" => {
            let frame_peer = peer.clone();
            let frame_stream_id = stream_id.clone();
            let close_peer = peer.clone();
            let close_stream_id = stream_id.clone();
            runtime
                .open(
                    &stream_id,
                    move |frame| {
                        let _ = frame_peer.notify(
                            "worker/frame",
                            json!({ "streamId": frame_stream_id, "frame": frame }),
                        );
                    },
                    move || {
                        let _ = close_peer
                            .notify("worker/closed", json!({ "streamId": close_stream_id }));
                    },
                )
                .map_err(worker_error)?;
        }
        "worker/send" => {
            if !params["frame"].is_object() {
                return Err(PeerError::new("invalid_frame"));
            }
            if runtime.send(&stream_id, params["frame"].take()).is_err() {
                runtime.close(&stream_id);
                peer.notify("worker/closed", json!({ "streamId": stream_id }))?;
            }
        }
        "worker/close" => runtime.close(&stream_id),
        _ => return Err(PeerError::new("unknown_operation")),
    }
    Ok(Value::Null)
}

async fn run_worker(path: &Path, stop: CancellationToken) -> Result<(), PeerError> {
    let config = config::worker(path)?;
    let profile = profile_for(&config.run_as_user)?;
    validate_worker_agent(&profile)
        .await
        .map_err(worker_error)?;
    let runtime = Arc::new(
        AccountWorker::new(config.agy_path, config.cwd, config.probe_timeout)
            .map_err(worker_error)?,
    );
    let (peer, mut requests) = tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        connected = broker::connect(config.client) => connected?,
    };
    let ready = tokio::select! {
        _ = stop.cancelled() => {
            peer.close();
            return Ok(());
        },
        ready = peer.request("broker/ready", json!({}), READY_TIMEOUT) => ready,
    };
    if let Err(error) = ready {
        peer.close();
        return Err(error);
    }
    eprintln!("Account worker connected.");
    let mut probes = JoinSet::new();
    let result = loop {
        let mut request = tokio::select! {
            biased;
            _ = stop.cancelled() => break Ok(()),
            _ = peer.closed() => break Err(PeerError::new("disconnected")),
            _ = probes.join_next(), if !probes.is_empty() => continue,
            request = requests.recv() => match request {
                Some(request) => request,
                None => break Err(PeerError::new("disconnected")),
            },
        };
        if request.method == "worker/probe" && request.params["groupId"].is_string() {
            // 额度探测独立运行，避免阻塞已获租约的 ACP 流。
            let runtime = runtime.clone();
            let peer = peer.clone();
            probes.spawn(async move {
                let group = request.params["groupId"].as_str().expect("group string");
                let result = runtime
                    .probe(group)
                    .await
                    .map(|quota| json!(quota))
                    .map_err(worker_error);
                request.reply(&peer, result);
            });
        } else {
            let result = handle_stream(&runtime, &peer, &request.method, &mut request.params);
            request.reply(&peer, result);
        }
    };
    peer.close();
    runtime.shutdown().await;
    while probes.join_next().await.is_some() {}
    result
}

async fn run_ingress(path: &Path, stop: CancellationToken) -> Result<(), PeerError> {
    let (peer, mut requests) = tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        connected = broker::connect(config::ingress(path)?) => connected?,
    };
    let ready = tokio::select! {
        _ = stop.cancelled() => {
            peer.close();
            return Ok(());
        },
        ready = peer.request("broker/ready", json!({}), READY_TIMEOUT) => ready,
    };
    if let Err(error) = ready {
        peer.close();
        return Err(error);
    }
    let send = async {
        let mut stdin = BufReader::new(tokio::io::stdin());
        while let Ok(Some(frame)) = read_frame(&mut stdin).await {
            if peer.notify("acp/frame", json!({ "frame": frame })).is_err() {
                break;
            }
        }
    };
    let receive = async {
        let mut stdout = tokio::io::stdout();
        while let Some(request) = requests.recv().await {
            let result = if request.method == "acp/frame" && request.params["frame"].is_object() {
                write_frame(&mut stdout, &request.params["frame"])
                    .await
                    .map(|()| Value::Null)
                    .map_err(|_| PeerError::new("invalid_frame"))
            } else {
                Err(PeerError::new("invalid_frame"))
            };
            request.reply(&peer, result);
        }
    };
    tokio::select! {
        _ = stop.cancelled() => {},
        _ = peer.closed() => {},
        _ = send => {},
        _ = receive => {},
    }
    peer.close();
    Ok(())
}

async fn wait_for_signal() {
    let interrupt = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = interrupt => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    interrupt.await;
}

async fn run(mode: &str, path: &Path) -> Result<(), PeerError> {
    let stop = CancellationToken::new();
    let signal_stop = stop.clone();
    tokio::spawn(async move {
        wait_for_signal().await;
        signal_stop.cancel();
    });
    match mode {
        "serve" => broker::serve(config::broker(path)?, stop).await,
        "worker" => run_worker(path, stop).await,
        "ingress" => run_ingress(path, stop).await,
        _ => unreachable!("validated command"),
    }
}

fn main() -> ExitCode {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--version" {
        println!("aas {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let (mode, path) = match args.as_slice() {
        [mode, file] if matches!(mode.to_str(), Some("serve" | "worker" | "ingress")) => {
            (mode.to_str().expect("validated command"), Path::new(file))
        }
        _ => {
            eprintln!("Usage: aas <serve|worker|ingress> <local-config.json>");
            return ExitCode::from(2);
        }
    };
    let result = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let result = runtime.block_on(run(mode, path));
            // An SSH ingress can lose its broker while stdin is still held open
            // by the client. Tokio cannot cancel the blocking console read.
            runtime.shutdown_timeout(Duration::from_millis(200));
            result
        }
        Err(_) => Err(PeerError::new("startup_failed")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Antigravity Account Switcher: {}", error.category());
            ExitCode::FAILURE
        }
    }
}
