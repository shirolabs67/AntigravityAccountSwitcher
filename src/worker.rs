use std::collections::HashMap;
use std::future::pending;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::bytes::Regex;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::wire::{MAX_FRAME, encode_frame, read_frame};

const QUOTA_OUTPUT_LIMIT: usize = 1024 * 1024;
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const MAX_QUEUED_FRAMES: usize = 512;

static NEEDS_LOGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:authentication required|not (?:logged|signed) in|(?:sign[- ]in|log[- ]?in) required|invalid_grant|unauthenticated|401\s+unauthorized|secret keyring is locked)\b").unwrap()
});
static INTERACTIVE_AUTH_REQUIRED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)authentication required\.\s+please visit the url to log in|secret keyring is locked",
    )
    .unwrap()
});

#[derive(Debug, PartialEq, Eq)]
pub enum WorkerError {
    AgentMissing,
    InvalidOptions,
    QuotaAuth,
    QuotaTimeout,
    QuotaInvalid,
    QuotaUnavailable,
    StreamInvalid,
    StreamUnavailable,
}

impl WorkerError {
    pub fn category(&self) -> &'static str {
        match self {
            Self::AgentMissing => "agent_missing",
            Self::InvalidOptions => "invalid_worker_options",
            Self::QuotaAuth => "quota_auth",
            Self::QuotaTimeout => "quota_timeout",
            Self::QuotaInvalid => "quota_invalid",
            Self::QuotaUnavailable => "quota_unavailable",
            Self::StreamInvalid => "stream_invalid",
            Self::StreamUnavailable => "stream_unavailable",
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub weekly: f64,
    pub five_hour: f64,
}

/// Validate the dedicated agent using the profile of the actual worker user.
pub async fn validate_worker_agent(profile: &Path) -> Result<(), WorkerError> {
    let path = profile.join("config").join("agents").join("dsh-bridge.md");
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| WorkerError::AgentMissing)?;
    let info = file
        .metadata()
        .await
        .map_err(|_| WorkerError::AgentMissing)?;
    if !info.is_file() || info.len() == 0 {
        return Err(WorkerError::AgentMissing);
    }
    Ok(())
}

fn parse_quota(output: &[u8], group_id: &str) -> Result<Quota, WorkerError> {
    let value: Value = serde_json::from_slice(output).map_err(|_| WorkerError::QuotaInvalid)?;
    let envelope = value.as_object().ok_or(WorkerError::QuotaInvalid)?;
    if envelope
        .get("status")
        .is_some_and(|status| status != "SUCCESS")
    {
        let needs_login = envelope
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| NEEDS_LOGIN.is_match(error.as_bytes()));
        return Err(if needs_login {
            WorkerError::QuotaAuth
        } else {
            WorkerError::QuotaUnavailable
        });
    }
    // 只接受目标模型组的完整额度，字段缺失应归为探测失败。
    let groups = value["command"]["data"]["groups"]
        .as_array()
        .ok_or(WorkerError::QuotaInvalid)?;
    let mut matching = groups.iter().filter(|group| group["name"] == group_id);
    let group = matching.next().ok_or(WorkerError::QuotaInvalid)?;
    if matching.next().is_some() {
        return Err(WorkerError::QuotaInvalid);
    }
    let buckets = group["buckets"]
        .as_array()
        .ok_or(WorkerError::QuotaInvalid)?;
    let mut weekly = None;
    let mut five_hour = None;
    for item in buckets {
        let bucket = item.as_object().ok_or(WorkerError::QuotaInvalid)?;
        let window = match bucket.get("window").and_then(Value::as_str) {
            Some("weekly") => &mut weekly,
            Some("5h") => &mut five_hour,
            _ => continue,
        };
        if window.is_some()
            || bucket.get("disabled").and_then(Value::as_bool) == Some(true)
            || bucket.get("enabled").and_then(Value::as_bool) == Some(false)
        {
            return Err(WorkerError::QuotaInvalid);
        }
        let fraction = bucket
            .get("remaining_fraction")
            .and_then(Value::as_f64)
            .filter(|fraction| (0.0..=1.0).contains(fraction))
            .ok_or(WorkerError::QuotaInvalid)?;
        *window = Some(fraction);
    }
    Ok(Quota {
        weekly: weekly.ok_or(WorkerError::QuotaInvalid)?,
        five_hour: five_hour.ok_or(WorkerError::QuotaInvalid)?,
    })
}

async fn collect_quota(child: &mut Child, group_id: &str) -> Result<Quota, WorkerError> {
    let mut stdout = child.stdout.take().ok_or(WorkerError::QuotaUnavailable)?;
    let mut stderr = child.stderr.take().ok_or(WorkerError::QuotaUnavailable)?;
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    let mut out_chunk = [0u8; 8192];
    let mut err_chunk = [0u8; 8192];
    let mut read_out = true;
    let mut read_err = true;

    while read_out || read_err {
        let (read, is_diagnostic) = tokio::select! {
            read = stdout.read(&mut out_chunk), if read_out => (read, false),
            read = stderr.read(&mut err_chunk), if read_err => (read, true),
        };
        let size = read.map_err(|_| WorkerError::QuotaUnavailable)?;
        if output.len() + diagnostics.len() + size > QUOTA_OUTPUT_LIMIT {
            return Err(WorkerError::QuotaInvalid);
        }
        if is_diagnostic {
            read_err = size > 0;
            let tail = diagnostics.len().saturating_sub(128);
            diagnostics.extend_from_slice(&err_chunk[..size]);
            // agy can wait for OAuth after stdin has closed. Detect the prompt
            // across chunks so it is reported as an auth error before the deadline.
            if INTERACTIVE_AUTH_REQUIRED.is_match(&diagnostics[tail..]) {
                return Err(WorkerError::QuotaAuth);
            }
        } else {
            read_out = size > 0;
            output.extend_from_slice(&out_chunk[..size]);
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|_| WorkerError::QuotaUnavailable)?;
    if !status.success()
        || (output.iter().all(u8::is_ascii_whitespace) && NEEDS_LOGIN.is_match(&diagnostics))
    {
        return Err(
            if NEEDS_LOGIN.is_match(&output) || NEEDS_LOGIN.is_match(&diagnostics) {
                WorkerError::QuotaAuth
            } else {
                WorkerError::QuotaUnavailable
            },
        );
    }
    parse_quota(&output, group_id)
}

struct QueuedFrame {
    line: Vec<u8>,
    _reservation: OwnedSemaphorePermit,
}

struct Stream {
    outbound: mpsc::Sender<QueuedFrame>,
    capacity: Arc<Semaphore>,
    stop: CancellationToken,
}

impl Stream {
    fn send(&self, frame: &Value) -> Result<(), WorkerError> {
        let line = encode_frame(frame).map_err(|_| WorkerError::StreamInvalid)?;
        let reservation = self
            .capacity
            .clone()
            .try_acquire_many_owned(line.len() as u32)
            .map_err(|_| WorkerError::StreamInvalid)?;
        self.outbound
            .try_send(QueuedFrame {
                line,
                _reservation: reservation,
            })
            .map_err(|_| WorkerError::StreamInvalid)
    }
}

type Streams = Arc<Mutex<HashMap<String, Arc<Stream>>>>;

/// Runs the official CLI with the worker process's existing OS identity and home.
pub struct AccountWorker {
    agy_path: PathBuf,
    cwd: PathBuf,
    probe_timeout: Duration,
    stop: CancellationToken,
    tasks: TaskTracker,
    streams: Streams,
    #[cfg(test)]
    command_prefix: Vec<std::ffi::OsString>,
}

impl AccountWorker {
    pub fn new(
        agy_path: PathBuf,
        cwd: PathBuf,
        probe_timeout: Duration,
    ) -> Result<Self, WorkerError> {
        if !agy_path.is_absolute()
            || !cwd.is_absolute()
            || !(Duration::from_millis(1)..=Duration::from_secs(120)).contains(&probe_timeout)
        {
            return Err(WorkerError::InvalidOptions);
        }
        Ok(Self {
            agy_path,
            cwd,
            probe_timeout,
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
            streams: Arc::default(),
            #[cfg(test)]
            command_prefix: Vec::new(),
        })
    }

    pub async fn probe(&self, group_id: &str) -> Result<Quota, WorkerError> {
        let (_tracked, mut child) = {
            let _streams = self.streams.lock().unwrap();
            if self.stop.is_cancelled() {
                return Err(WorkerError::QuotaUnavailable);
            }
            let child = self
                .command(&["-p", "/usage", "--output-format", "json"])
                .stdin(Stdio::null())
                .spawn()
                .map_err(|_| WorkerError::QuotaUnavailable)?;
            (self.tasks.token(), child)
        };
        let result = tokio::select! {
            () = self.stop.cancelled() => Err(WorkerError::QuotaUnavailable),
            result = timeout(self.probe_timeout, collect_quota(&mut child, group_id)) => {
                result.unwrap_or(Err(WorkerError::QuotaTimeout))
            }
        };
        if result.is_err() {
            let _ = child.kill().await;
        }
        result
    }

    pub fn open(
        &self,
        stream_id: &str,
        on_frame: impl Fn(Value) + Send + 'static,
        on_close: impl FnOnce() + Send + 'static,
    ) -> Result<(), WorkerError> {
        let mut streams = self.streams.lock().unwrap();
        if self.stop.is_cancelled() {
            return Err(WorkerError::StreamUnavailable);
        }
        if streams.contains_key(stream_id) {
            return Err(WorkerError::StreamInvalid);
        }
        let mut child = self
            .command(&[
                "acp",
                "--process-per-session",
                "--disable-telemetry",
                "--agent",
                "dsh-bridge",
            ])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|_| WorkerError::StreamUnavailable)?;
        let mut input = child.stdin.take().ok_or(WorkerError::StreamUnavailable)?;
        let mut output = BufReader::new(child.stdout.take().ok_or(WorkerError::StreamUnavailable)?);
        let mut diagnostics = child.stderr.take().ok_or(WorkerError::StreamUnavailable)?;
        let (outbound, mut queued) = mpsc::channel::<QueuedFrame>(MAX_QUEUED_FRAMES);
        let stream = Arc::new(Stream {
            outbound,
            capacity: Arc::new(Semaphore::new(MAX_FRAME * 2)),
            stop: self.stop.child_token(),
        });
        streams.insert(stream_id.to_owned(), stream.clone());
        let stream_id = stream_id.to_owned();
        let registry = self.streams.clone();
        self.tasks.spawn(async move {
            let write_frames = async {
                while let Some(frame) = queued.recv().await {
                    input.write_all(&frame.line).await?;
                }
                io::Result::Ok(())
            };
            let drain_diagnostics = async {
                // Stderr may close independently of the ACP stream.
                drain(&mut diagnostics).await?;
                pending::<io::Result<()>>().await
            };
            tokio::select! {
                biased;
                () = stream.stop.cancelled() => (),
                _ = read_frames(&mut output, on_frame) => (),
                _ = write_frames => (),
                _ = drain_diagnostics => (),
            }

            stream.stop.cancel();
            registry.lock().unwrap().remove(&stream_id);
            drop(input);
            drop(queued);
            on_close();

            // 关闭 stdin 后继续排空输出，给子进程留出自行退出的时间。
            let wait_for_cleanup = async {
                let drain_pipes = async {
                    let _ = tokio::join!(drain(&mut output), drain(&mut diagnostics));
                };
                tokio::select! {
                    status = child.wait() => status,
                    () = drain_pipes => child.wait().await,
                }
            };
            if !matches!(timeout(CLOSE_GRACE, wait_for_cleanup).await, Ok(Ok(_))) {
                let _ = child.kill().await;
            }
        });
        Ok(())
    }

    pub fn send(&self, stream_id: &str, mut frame: Value) -> Result<(), WorkerError> {
        let stream = self
            .streams
            .lock()
            .unwrap()
            .get(stream_id)
            .cloned()
            .filter(|stream| !stream.stop.is_cancelled())
            .ok_or(WorkerError::StreamUnavailable)?;
        if frame["jsonrpc"] != "2.0" {
            return Err(WorkerError::StreamInvalid);
        }
        // DSH 提供的路径属于客户端，远端会话使用 worker 配置的工作目录。
        if matches!(
            frame["method"].as_str(),
            Some("session/new" | "session/load" | "session/resume")
        ) {
            let params = frame["params"]
                .as_object_mut()
                .ok_or(WorkerError::StreamInvalid)?;
            params.insert(
                "cwd".to_owned(),
                Value::String(self.cwd.to_string_lossy().into_owned()),
            );
            params.remove("additionalDirectories");
        }
        let result = stream.send(&frame);
        if result.is_err() {
            stream.stop.cancel();
        }
        result
    }

    pub fn close(&self, stream_id: &str) {
        if let Some(stream) = self.streams.lock().unwrap().get(stream_id) {
            stream.stop.cancel();
        }
    }

    pub async fn shutdown(&self) {
        {
            let _streams = self.streams.lock().unwrap();
            self.stop.cancel();
            self.tasks.close();
        }
        self.tasks.wait().await;
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(&self.agy_path);
        #[cfg(test)]
        command.args(&self.command_prefix);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
            .args(arguments)
            .current_dir(&self.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

impl Drop for AccountWorker {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

async fn drain(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> io::Result<()> {
    tokio::io::copy(reader, &mut tokio::io::sink()).await?;
    Ok(())
}

async fn read_frames(
    reader: &mut (impl AsyncBufRead + Unpin),
    on_frame: impl Fn(Value),
) -> io::Result<()> {
    while let Some(frame) = read_frame(reader).await? {
        if frame["jsonrpc"] != "2.0" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid ACP frame",
            ));
        }
        on_frame(frame);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::oneshot;

    const FAKE_AGY: &str = r#"
        const assert = require('node:assert/strict');
        const [mode, response, ...args] = process.argv.slice(1);
        if (args[0] === '-p') {
            assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json']);
            if (mode === 'timeout') setInterval(() => {}, 1000);
            else if (mode === 'auth') {
                process.stderr.write('Authentication required. Please visit ');
                setTimeout(() => process.stderr.write('the URL to log in: https://example.invalid/'), 20);
                setInterval(() => {}, 1000);
            } else if (mode === 'oversize') {
                process.stdout.write('x'.repeat(600_000));
                process.stderr.write('y'.repeat(600_000));
            } else process.stdout.write(response);
        } else {
            assert.deepEqual(args, ['acp', '--process-per-session', '--disable-telemetry', '--agent', 'dsh-bridge']);
            const lines = require('node:readline').createInterface({ input: process.stdin });
            let sequence = 0;
            lines.on('line', line => {
                if (mode === 'invalid') return process.stdout.write('not ACP and contains test secret\n');
                const frame = JSON.parse(line);
                const reply = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { frame, sequence: ++sequence } });
                process.stdout.write(reply.slice(0, 8));
                process.stdout.write(reply.slice(8) + '\n');
            });
        }
    "#;

    fn worker(cwd: &Path, mode: &str, response: &str, probe_timeout: Duration) -> AccountWorker {
        let node = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|path| path.is_absolute() && path.is_file())
            .expect("Node.js is required for the fake CLI test");
        let mut worker = AccountWorker::new(node, cwd.to_owned(), probe_timeout).unwrap();
        worker.command_prefix = ["-e", FAKE_AGY, "--", mode, response]
            .map(Into::into)
            .to_vec();
        worker
    }

    fn usage(groups: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"status":"SUCCESS", "command":{"data":{"groups":groups}}}))
            .unwrap()
    }

    fn group(name: &str, buckets: Value) -> Value {
        json!({"name":name, "buckets":buckets})
    }

    #[test]
    fn quota_uses_exact_group_and_independent_windows() {
        let windows = json!([
            {"window":"5h", "remaining_fraction":0},
            {"window":"weekly", "remaining_fraction":0.05},
            {"window":"other"}
        ]);
        let data = usage(json!([
            group("Different Group", windows.clone()),
            group("Gemini Models", windows)
        ]));
        assert_eq!(
            parse_quota(&data, "Gemini Models"),
            Ok(Quota {
                weekly: 0.05,
                five_hour: 0.0
            })
        );
        assert_eq!(
            parse_quota(&data, "Gemini models"),
            Err(WorkerError::QuotaInvalid)
        );
    }

    #[test]
    fn quota_rejects_missing_ambiguous_or_malformed_windows() {
        let weekly = json!({"window":"weekly", "remaining_fraction":0.9});
        for short in [
            json!({"window":"daily", "remaining_fraction":0.8}),
            json!({"window":"5h", "remaining_fraction":0.8, "disabled":true}),
            json!({"window":"5h", "remaining_fraction":0.8, "enabled":false}),
            json!({"window":"5h", "remaining_fraction":"0.8"}),
            json!({"window":"5h", "remaining_fraction":1.1}),
            json!({"window":"5h", "remaining_fraction":-0.01}),
            json!({"window":"5h"}),
            weekly.clone(),
            Value::Null,
        ] {
            let data = usage(json!([group(
                "Gemini Models",
                json!([weekly.clone(), short])
            )]));
            assert_eq!(
                parse_quota(&data, "Gemini Models"),
                Err(WorkerError::QuotaInvalid)
            );
        }
        let valid = group(
            "Gemini Models",
            json!([weekly, {"window":"5h", "remaining_fraction":1}]),
        );
        assert_eq!(
            parse_quota(&usage(json!([valid.clone(), valid])), "Gemini Models"),
            Err(WorkerError::QuotaInvalid)
        );
        assert_eq!(
            parse_quota(b"{not-json}", "Gemini Models"),
            Err(WorkerError::QuotaInvalid)
        );
    }

    #[test]
    fn quota_auth_classification_never_contains_diagnostics() {
        let login = br#"{"status":"ERROR","error":"401 Unauthorized: test secret"}"#;
        assert_eq!(
            parse_quota(login, "Gemini Models"),
            Err(WorkerError::QuotaAuth)
        );
        assert_eq!(WorkerError::QuotaAuth.category(), "quota_auth");
        assert_eq!(
            parse_quota(
                br#"{"status":"ERROR","error":"unavailable"}"#,
                "Gemini Models"
            ),
            Err(WorkerError::QuotaUnavailable)
        );
        assert!(INTERACTIVE_AUTH_REQUIRED.is_match(
            b"Authentication required.\r\nPlease visit the URL to log in: https://example.invalid/"
        ));
        assert!(INTERACTIVE_AUTH_REQUIRED.is_match(b"Error: secret keyring is locked"));
    }

    #[tokio::test]
    async fn invalid_child_stdout_never_reaches_the_acp_connection() {
        let output =
            b"{\"jsonrpc\":\"2.0\",\"id\":17,\"result\":{}}\nnot ACP and contains test secret\n";
        let mut reader = &output[..];
        let seen = Mutex::new(Vec::new());
        let result = read_frames(&mut reader, |frame| seen.lock().unwrap().push(frame)).await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            seen.into_inner().unwrap(),
            [json!({"jsonrpc":"2.0", "id":17, "result":{}})]
        );
    }

    #[tokio::test]
    async fn agent_file_is_required_in_the_worker_profile() {
        let profile = tempfile::tempdir().unwrap();
        let agents = profile.path().join("config").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        let agent = agents.join("dsh-bridge.md");
        assert_eq!(
            validate_worker_agent(profile.path()).await,
            Err(WorkerError::AgentMissing)
        );
        std::fs::write(&agent, []).unwrap();
        assert_eq!(
            validate_worker_agent(profile.path()).await,
            Err(WorkerError::AgentMissing)
        );
        std::fs::write(&agent, "---\nname: dsh-bridge\n---\n").unwrap();
        assert!(validate_worker_agent(profile.path()).await.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires Node.js for the fake CLI"]
    async fn subprocess_quota_probes_enforce_limits_and_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path();
        let deadline = Duration::from_secs(5);
        let data = usage(json!([group(
            "Gemini Models",
            json!([
                {"window":"weekly", "remaining_fraction":0.05},
                {"window":"5h", "remaining_fraction":0}
            ])
        )]));
        let valid = worker(cwd, "valid", std::str::from_utf8(&data).unwrap(), deadline);
        assert_eq!(
            valid.probe("Gemini Models").await,
            Ok(Quota {
                weekly: 0.05,
                five_hour: 0.0
            })
        );
        let auth = worker(cwd, "auth", "", deadline);
        assert_eq!(
            auth.probe("Gemini Models").await,
            Err(WorkerError::QuotaAuth)
        );
        let oversized = worker(cwd, "oversize", "", deadline);
        assert_eq!(
            oversized.probe("Gemini Models").await,
            Err(WorkerError::QuotaInvalid)
        );
        let stalled = worker(cwd, "timeout", "", Duration::from_millis(100));
        assert_eq!(
            stalled.probe("Gemini Models").await,
            Err(WorkerError::QuotaTimeout)
        );

        let stopping = Arc::new(worker(cwd, "timeout", "", deadline));
        let probe = {
            let stopping = stopping.clone();
            tokio::spawn(async move { stopping.probe("Gemini Models").await })
        };
        timeout(deadline, async {
            while stopping.tasks.is_empty() {
                tokio::task::yield_now().await;
            }
            stopping.shutdown().await;
        })
        .await
        .unwrap();
        assert_eq!(probe.await.unwrap(), Err(WorkerError::QuotaUnavailable));
        assert!(stopping.tasks.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires Node.js for the fake CLI"]
    async fn subprocess_acp_keeps_streams_separate_and_rewrites_paths() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path();
        let deadline = Duration::from_secs(5);
        let worker = worker(cwd, "acp", "", deadline);
        let frame = json!({"jsonrpc":"2.0", "id":17, "method":"session/new", "params":{
            "cwd":"remote-machine-only", "additionalDirectories":["remote-machine-only"], "mcpServers":[],
            "_meta":{"antigravity":{"systemPrompt":{"append":"测试上下文"}}}
        }});
        let (closed_tx, mut closed_rx) = mpsc::channel(2);
        let mut replies = Vec::new();
        for stream in ["one", "two"] {
            let (reply_tx, reply_rx) = mpsc::channel(1);
            let closed_tx = closed_tx.clone();
            worker
                .open(
                    stream,
                    move |reply| reply_tx.try_send(reply).unwrap(),
                    move || closed_tx.try_send(stream).unwrap(),
                )
                .unwrap();
            worker.send(stream, frame.clone()).unwrap();
            replies.push(reply_rx);
        }
        assert_eq!(
            worker.open("one", |_| {}, || {}),
            Err(WorkerError::StreamInvalid)
        );
        for mut replies in replies {
            let reply = timeout(deadline, replies.recv()).await.unwrap().unwrap();
            assert_eq!(reply["id"], 17);
            assert_eq!(reply["result"]["sequence"], 1);
            let params = &reply["result"]["frame"]["params"];
            assert_eq!(params["cwd"], cwd.to_string_lossy().as_ref());
            assert!(params.get("additionalDirectories").is_none());
            assert_eq!(params["_meta"], frame["params"]["_meta"]);
        }
        worker.close("one");
        worker.close("one");
        assert_eq!(
            worker.send("one", frame),
            Err(WorkerError::StreamUnavailable)
        );
        assert_eq!(
            timeout(deadline, closed_rx.recv()).await.unwrap(),
            Some("one")
        );
        timeout(deadline, worker.shutdown()).await.unwrap();
        assert_eq!(closed_rx.try_recv().unwrap(), "two");
    }

    #[tokio::test]
    #[ignore = "requires Node.js for the fake CLI"]
    async fn subprocess_invalid_acp_frame_closes_only_its_stream() {
        let directory = tempfile::tempdir().unwrap();
        let deadline = Duration::from_secs(5);
        let worker = worker(directory.path(), "invalid", "", deadline);
        let (closed_tx, closed_rx) = oneshot::channel();
        worker
            .open(
                "bad",
                |_| panic!("forwarded invalid child stdout"),
                || closed_tx.send(()).unwrap(),
            )
            .unwrap();
        worker
            .send("bad", json!({"jsonrpc":"2.0", "method":"initialize"}))
            .unwrap();
        timeout(deadline, closed_rx).await.unwrap().unwrap();
        assert_eq!(
            worker.send("bad", json!({"jsonrpc":"2.0"})),
            Err(WorkerError::StreamUnavailable)
        );
        timeout(deadline, worker.shutdown()).await.unwrap();
    }
}
