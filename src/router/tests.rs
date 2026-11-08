use std::sync::atomic::Ordering;

use tokio::sync::{Notify, oneshot};
use tokio::time::{advance, timeout};

use crate::acp_backend::{CloseListener, FrameListener};

use super::*;

const MODEL: &str = "test-model";
const NATIVE: &str = "same-native-session-id";

#[derive(Default)]
struct FakeWorker {
    frames: Mutex<Vec<Value>>,
    on_frame: Mutex<Option<FrameListener>>,
    on_close: Mutex<Option<CloseListener>>,
    changed: Notify,
    closed: CancellationToken,
    pause_open: AtomicBool,
}

impl FakeWorker {
    fn inject(&self, mut frame: Value) {
        frame["jsonrpc"] = json!("2.0");
        if let Some(listener) = self.on_frame.lock().unwrap().as_ref() {
            listener(frame);
        }
    }

    fn reply(&self, request: &Value, result: Value) {
        self.inject(json!({"id": request["id"], "result": result}));
    }

    async fn frame(&self, condition: impl Fn(&Value) -> bool) -> Value {
        timeout(Duration::from_secs(2), async {
            loop {
                if let Some(frame) = self
                    .frames
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|frame| condition(frame))
                    .cloned()
                {
                    return frame;
                }
                self.changed.notified().await;
            }
        })
        .await
        .expect("missing native ACP frame")
    }

    async fn method(&self, method: &str) -> Value {
        self.frame(|frame| frame["method"] == method).await
    }
}

impl WorkerStream for FakeWorker {
    fn send(&self, frame: Value) -> Result<(), PeerError> {
        if self.closed.is_cancelled() {
            return Err(PeerError::new("disconnected"));
        }
        self.frames.lock().unwrap().push(frame.clone());
        self.changed.notify_one();
        match frame["method"].as_str() {
            Some("initialize") => self.reply(&frame, json!({"protocolVersion": 1})),
            Some("session/new") if !self.pause_open.load(Ordering::SeqCst) => self.reply(
                &frame,
                json!({"sessionId": NATIVE, "configOptions": [], "_meta": {"example": true}}),
            ),
            Some("session/close") => self.reply(&frame, json!({})),
            _ => {}
        }
        Ok(())
    }

    fn on_frame(&self, listener: FrameListener) {
        *self.on_frame.lock().unwrap() = Some(listener);
    }

    fn on_close(&self, listener: CloseListener) {
        *self.on_close.lock().unwrap() = Some(listener);
    }

    fn close(&self) {
        self.closed.cancel();
        if let Some(listener) = self.on_close.lock().unwrap().take() {
            listener();
        }
    }
}

type ProbeResult = Result<(f64, f64), PeerError>;

struct Directory {
    quotas: Mutex<HashMap<String, ProbeResult>>,
    probes: Mutex<Vec<(String, String)>>,
    hold_probe: Mutex<Option<oneshot::Receiver<()>>>,
    probing: Notify,
    streams: mpsc::UnboundedSender<Arc<FakeWorker>>,
}

impl Directory {
    fn quota(&self, account: &str, weekly: f64, five_hour: f64) {
        self.quotas
            .lock()
            .unwrap()
            .insert(account.into(), Ok((weekly, five_hour)));
    }

    fn probes(&self) -> Vec<String> {
        std::mem::take(&mut *self.probes.lock().unwrap())
            .into_iter()
            .map(|(account, group)| {
                assert_eq!(group, "exact-model-group");
                account
            })
            .collect()
    }
}

#[async_trait]
impl WorkerDirectory for Directory {
    async fn probe(&self, account: &str, group: &str) -> Result<Quota, PeerError> {
        self.probes
            .lock()
            .unwrap()
            .push((account.into(), group.into()));
        self.probing.notify_one();
        let hold = self.hold_probe.lock().unwrap().take();
        if let Some(hold) = hold {
            let _ = hold.await;
        }
        let (weekly, five_hour) = self.quotas.lock().unwrap()[account].clone()?;
        Ok(Quota { weekly, five_hour })
    }

    async fn open(&self, _account: &str) -> Result<Arc<dyn WorkerStream>, PeerError> {
        let worker = Arc::new(FakeWorker::default());
        self.streams.send(worker.clone()).unwrap();
        Ok(worker)
    }
}

fn harness() -> (
    Router,
    Arc<Directory>,
    mpsc::UnboundedReceiver<Arc<FakeWorker>>,
) {
    let (streams, worker_rx) = mpsc::unbounded_channel();
    let directory = Arc::new(Directory {
        quotas: Mutex::new(HashMap::new()),
        probes: Mutex::new(Vec::new()),
        hold_probe: Mutex::new(None),
        probing: Notify::new(),
        streams,
    });
    directory.quota("a", 0.75, 0.75);
    directory.quota("b", 0.80, 0.80);
    let router = Router::new(
        RouterConfig {
            accounts: vec!["a".into(), "b".into()],
            instances: HashMap::from([
                (
                    "dshA".into(),
                    InstanceConfig {
                        mcp_port: 43101,
                        allow_account_switch: true,
                    },
                ),
                (
                    "dshB".into(),
                    InstanceConfig {
                        mcp_port: 43102,
                        allow_account_switch: false,
                    },
                ),
            ]),
            model_groups: HashMap::from([(MODEL.into(), "exact-model-group".into())]),
            threshold: 0.05,
            exhausted_message: "额度测试".into(),
        },
        directory.clone(),
    );
    (router, directory, worker_rx)
}

struct Client {
    connection: RouterConnection,
    frames: mpsc::UnboundedReceiver<Value>,
    buffered: Vec<Value>,
    id: usize,
}

impl Client {
    async fn connect(router: &Router, instance: &str) -> Self {
        let (tx, frames) = mpsc::unbounded_channel();
        let connection = router
            .connect(instance, move |frame| {
                tx.send(frame).map_err(|_| PeerError::new("disconnected"))
            })
            .unwrap();
        let mut client = Self {
            connection,
            frames,
            buffered: Vec::new(),
            id: 0,
        };
        let init = client
            .result("initialize", json!({"protocolVersion": 1}))
            .await;
        assert_eq!(init["_meta"][EXTENSION]["version"], 1);
        client
    }

    fn send(&self, mut frame: Value) {
        frame["jsonrpc"] = json!("2.0");
        self.connection.receive(frame).unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> usize {
        self.id += 1;
        self.send(json!({"id": self.id, "method": method, "params": params}));
        self.id
    }

    fn notify(&self, method: &str, params: Value) {
        self.send(json!({"method": method, "params": params}));
    }

    async fn frame(&mut self, condition: impl Fn(&Value) -> bool) -> Value {
        if let Some(at) = self.buffered.iter().position(&condition) {
            return self.buffered.remove(at);
        }
        timeout(Duration::from_secs(2), async {
            while let Some(frame) = self.frames.recv().await {
                if condition(&frame) {
                    return frame;
                }
                self.buffered.push(frame);
            }
            panic!("router connection closed");
        })
        .await
        .expect("missing router ACP frame")
    }

    async fn method(&mut self, method: &str) -> Value {
        self.frame(|frame| frame["method"] == method).await
    }

    async fn response(&mut self, id: usize) -> Value {
        self.frame(|frame| frame["id"] == id && frame.get("method").is_none())
            .await
    }

    async fn result(&mut self, method: &str, params: Value) -> Value {
        let id = self.request(method, params);
        expect_result(self.response(id).await)
    }

    async fn acquire(&mut self, chat: &str) -> Value {
        self.result(ACQUIRE, acquire_params(chat)).await
    }

    async fn release(&mut self, lease: &Value) {
        self.result(RELEASE, json!({"leaseId": lease["leaseId"]}))
            .await;
    }

    async fn open(&mut self, lease: &Value, servers: Value) -> Value {
        self.result("session/new", open_params(lease, servers))
            .await
    }
}

fn expect_result(frame: Value) -> Value {
    assert!(frame["error"].is_null(), "{frame}");
    frame["result"].clone()
}

fn acquire_params(chat: &str) -> Value {
    json!({"chatKey": chat, "model": MODEL})
}

fn open_params(lease: &Value, servers: Value) -> Value {
    json!({
        "cwd": "/original",
        "mcpServers": servers,
        "_meta": {
            (EXTENSION): {"leaseId": lease["leaseId"]},
            "antigravity": {"systemPrompt": {"append": "test prompt"}},
        },
    })
}

fn prompt_params(lease: &Value, session: &Value) -> Value {
    json!({"sessionId": session["sessionId"], "prompt": [], "_meta": {(EXTENSION): {"leaseId": lease["leaseId"]}}})
}

fn config_params(lease: &Value, session: &Value) -> Value {
    json!({
        "sessionId": session["sessionId"], "configId": "model", "value": MODEL,
        "_meta": {(EXTENSION): {"leaseId": lease["leaseId"]}},
    })
}

fn mcp_bridge() -> Value {
    json!([{
        "type": "http",
        "name": "dsh",
        "url": format!("http://127.0.0.1:23100/mcp/{}", "a".repeat(32)),
        "headers": [{"name": "Authorization", "value": format!("Bearer {}", "b".repeat(48))}],
    }])
}

#[tokio::test]
async fn uses_both_windows_round_robin_and_exhaustion() {
    let (router, workers, mut streams) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    workers.quota("a", 0.20, 0.0499);
    workers.quota("b", 0.05, 0.40);
    let first = client.acquire("chat").await;
    assert_eq!(first["accountId"], "b");
    assert_eq!(workers.probes(), ["a", "b"]);
    client.release(&first).await;

    workers.quota("b", 0.0499, 0.80);
    workers.quota("a", 0.50, 0.05);
    let recovered = client.acquire("chat").await;
    assert_eq!(recovered["accountId"], "a");
    assert_ne!(first["generationId"], recovered["generationId"]);
    assert_eq!(workers.probes(), ["b", "a"]);
    client.release(&recovered).await;

    workers.quota("a", 0.04, 0.04);
    workers
        .quotas
        .lock()
        .unwrap()
        .insert("b".into(), Err(PeerError::new("quota_auth")));
    let id = client.request(ACQUIRE, acquire_params("chat"));
    let unknown = client.response(id).await;
    assert_eq!(unknown["error"]["code"], -32040);
    assert_eq!(
        unknown["error"]["data"]["accounts"],
        json!([{"accountId": "b", "reason": "login_required"}])
    );
    assert_eq!(workers.probes(), ["a", "b"]);

    workers.quota("b", 0.03, f64::NAN);
    let id = client.request(ACQUIRE, acquire_params("chat"));
    let malformed = client.response(id).await;
    assert_eq!(
        malformed["error"]["data"]["accounts"][0]["reason"],
        "invalid_quota"
    );

    workers.quota("b", 0.03, 0.03);
    let exhausted = client.acquire("chat").await;
    assert_eq!(exhausted["status"], "exhausted");
    let session = client.open(&exhausted, json!([])).await;
    let result = client
        .result("session/prompt", prompt_params(&exhausted, &session))
        .await;
    assert_eq!(result, json!({"stopReason": "end_turn"}));
    assert_eq!(
        client.method("session/update").await["params"]["update"]["content"]["text"],
        "额度测试"
    );
    assert!(streams.try_recv().is_err());
    client.release(&exhausted).await;
}

#[tokio::test]
async fn switches_accounts_without_crossing_sessions_callbacks_or_turns() {
    let (router, workers, mut streams) = harness();
    let mut a = Client::connect(&router, "dshA").await;
    let mut b = Client::connect(&router, "dshB").await;
    let first = a.acquire("chat").await;
    let a_session = a.open(&first, mcp_bridge()).await;
    let old_worker = streams.try_recv().unwrap();
    let native_open = old_worker.method("session/new").await;
    let native_bridge = &native_open["params"]["mcpServers"][0];
    assert_eq!(
        native_bridge["url"],
        format!("http://127.0.0.1:43101/mcp/{}", "a".repeat(32))
    );
    assert_eq!(native_bridge["headers"], mcp_bridge()[0]["headers"]);
    assert_eq!(
        native_open["params"]["_meta"],
        json!({"antigravity": {"systemPrompt": {"append": "test prompt"}}})
    );
    assert_eq!(a_session["_meta"][EXTENSION]["nativeSessionId"], NATIVE);
    assert_eq!(a_session["_meta"]["example"], true);

    let a_prompt = a.request("session/prompt", prompt_params(&first, &a_session));
    let old_prompt = old_worker.method("session/prompt").await;
    assert_eq!(old_prompt["params"]["sessionId"], NATIVE);
    workers.quota("a", 0.01, 0.01);
    let fresh = b.acquire("chat").await;
    assert_eq!(fresh["accountId"], "b");
    let b_session = b.open(&fresh, mcp_bridge()).await;
    assert_ne!(a_session["sessionId"], b_session["sessionId"]);
    let new_worker = streams.try_recv().unwrap();
    let native_open = new_worker.method("session/new").await;
    assert_eq!(
        native_open["params"]["mcpServers"][0]["url"],
        format!("http://127.0.0.1:43102/mcp/{}", "a".repeat(32))
    );
    let b_prompt = b.request("session/prompt", prompt_params(&fresh, &b_session));
    let new_prompt = new_worker.method("session/prompt").await;
    assert_eq!(old_prompt["id"], new_prompt["id"]);
    let cross_lease = a.request(
        "session/set_config_option",
        config_params(&fresh, &a_session),
    );
    let cross_session = b.request(
        "session/set_config_option",
        config_params(&fresh, &a_session),
    );
    assert_eq!(a.response(cross_lease).await["error"]["code"], -32042);
    assert_eq!(b.response(cross_session).await["error"]["code"], -32042);

    for (worker, label) in [(&old_worker, "old account"), (&new_worker, "new account")] {
        worker.inject(json!({"method": "session/update", "params": {"sessionId": NATIVE, "update": {"text": label}}}));
        worker.inject(json!({"method": "session/request_permission", "id": 17, "params": {"sessionId": NATIVE}}));
    }
    assert_eq!(
        a.method("session/update").await["params"]["update"]["text"],
        "old account"
    );
    assert_eq!(
        b.method("session/update").await["params"]["update"]["text"],
        "new account"
    );
    let a_permission = a.method("session/request_permission").await;
    let b_permission = b.method("session/request_permission").await;
    assert_ne!(a_permission["id"], b_permission["id"]);
    assert_eq!(a_permission["params"]["sessionId"], a_session["sessionId"]);
    assert_eq!(b_permission["params"]["sessionId"], b_session["sessionId"]);
    b.send(json!({"id": a_permission["id"], "result": {"wrong": true}}));
    b.result("session/close", json!({"sessionId": "does-not-exist"}))
        .await;
    assert!(
        !old_worker
            .frames
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame["id"] == 17)
    );
    old_worker.inject(json!({"method": "$/cancel_request", "params": {"requestId": 17}}));
    assert_eq!(
        a.method("$/cancel_request").await["params"]["requestId"],
        a_permission["id"]
    );
    a.send(json!({"id": a_permission["id"], "result": {"outcome": {"outcome": "cancelled"}}}));
    b.send(json!({"id": b_permission["id"], "result": {"outcome": {"outcome": "selected", "optionId": "b"}}}));
    assert_eq!(
        old_worker.frame(|frame| frame["id"] == 17).await["result"]["outcome"]["outcome"],
        "cancelled"
    );
    assert_eq!(
        new_worker.frame(|frame| frame["id"] == 17).await["result"]["outcome"]["optionId"],
        "b"
    );

    new_worker.reply(&new_prompt, json!({"stopReason": "end_turn"}));
    expect_result(b.response(b_prompt).await);
    b.release(&fresh).await;
    assert!(!old_worker.closed.is_cancelled());
    old_worker.reply(&old_prompt, json!({"stopReason": "end_turn"}));
    expect_result(a.response(a_prompt).await);
    let continuation = a.request("session/prompt", prompt_params(&first, &a_session));
    let native_next = old_worker
        .frame(|frame| frame["method"] == "session/prompt" && frame["id"] != old_prompt["id"])
        .await;
    old_worker.inject(
        json!({"id": 18, "method": "session/request_permission", "params": {"sessionId": NATIVE}}),
    );
    let pending = a.method("session/request_permission").await;
    old_worker.reply(&native_next, json!({"stopReason": "end_turn"}));
    expect_result(a.response(continuation).await);
    a.release(&first).await;
    assert!(!old_worker.closed.is_cancelled());
    let id = a.request(ACQUIRE, acquire_params("chat"));
    a.result("session/close", json!({"sessionId": "does-not-exist"}))
        .await;
    assert!(!a.buffered.iter().any(|frame| frame["id"] == id));
    a.send(json!({"id": pending["id"], "result": {"outcome": {"outcome": "cancelled"}}}));
    timeout(Duration::from_secs(2), old_worker.closed.cancelled())
        .await
        .unwrap();
    let next = expect_result(a.response(id).await);
    assert_eq!(next["accountId"], "b");
    a.release(&next).await;
}

#[tokio::test]
async fn validates_mcp_and_remaps_cancellation_without_replaying_lost_prompt() {
    let (router, _, mut streams) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    let lease = client.acquire("chat").await;
    let mut bridge = mcp_bridge();
    bridge[0]["url"] = json!(format!(
        "http://127.0.0.1.example:23100/mcp/{}",
        "a".repeat(32)
    ));
    let invalid = client.request("session/new", open_params(&lease, bridge));
    assert_eq!(client.response(invalid).await["error"]["code"], -32602);
    assert!(streams.try_recv().is_err());

    let session = client.open(&lease, mcp_bridge()).await;
    let worker = streams.try_recv().unwrap();
    let prompt = client.request("session/prompt", prompt_params(&lease, &session));
    let native = worker.method("session/prompt").await;
    worker.inject(
        json!({"id": 101, "method": "session/request_permission", "params": {"sessionId": NATIVE}}),
    );
    client.method("session/request_permission").await;
    client.notify("$/cancel_request", json!({"requestId": prompt}));
    let cancelled = worker.method("$/cancel_request").await;
    assert_eq!(cancelled["params"]["requestId"], native["id"]);
    client.notify("session/cancel", json!({"sessionId": session["sessionId"]}));
    let cancelled = worker.method("session/cancel").await;
    assert_eq!(cancelled["params"]["sessionId"], NATIVE);
    assert_eq!(
        worker.frame(|frame| frame["id"] == 101).await["result"]["outcome"]["outcome"],
        "cancelled"
    );

    worker.close();
    let fault = client.response(prompt).await;
    assert_eq!(fault["error"]["data"]["kind"], "submission_unknown");
    assert_eq!(
        worker
            .frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["method"] == "session/prompt")
            .count(),
        1
    );
    client.release(&lease).await;
    let next = client.acquire("chat").await;
    assert_eq!(next["accountId"], lease["accountId"]);
    assert_ne!(next["generationId"], lease["generationId"]);
    client.release(&next).await;
}

#[tokio::test]
async fn cancels_pending_acquisition_without_reserving_an_orphan_chat() {
    let (router, workers, _) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    let (_complete_probe, hold) = oneshot::channel();
    *workers.hold_probe.lock().unwrap() = Some(hold);
    let id = client.request(ACQUIRE, acquire_params("cancelled-chat"));
    timeout(Duration::from_secs(2), workers.probing.notified())
        .await
        .unwrap();
    assert_eq!(workers.probes(), ["a"]);
    client.notify("$/cancel_request", json!({"requestId": id}));
    assert_eq!(client.response(id).await["error"]["code"], -32800);
    let lease = client.acquire("cancelled-chat").await;
    assert_eq!(lease["accountId"], "a");
    client.release(&lease).await;
}

#[tokio::test(start_paused = true)]
async fn expires_session_setup_and_discards_late_session_without_interrupting_another_prompt() {
    let (router, _, mut streams) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    let live = client.acquire("live").await;
    let session = client.open(&live, json!([])).await;
    let worker = streams.try_recv().unwrap();
    let in_flight = client.request("session/prompt", prompt_params(&live, &session));
    let prompt = worker.method("session/prompt").await;

    let stale = client.acquire("stale").await;
    worker.pause_open.store(true, Ordering::SeqCst);
    let previous = worker.method("session/new").await;
    let opening = client.request("session/new", open_params(&stale, json!([])));
    let native_opening = worker
        .frame(|frame| frame["method"] == "session/new" && frame["id"] != previous["id"])
        .await;
    assert_eq!(native_opening["params"]["cwd"], "/original");
    client.release(&stale).await;
    let next = client.request(ACQUIRE, acquire_params("stale"));
    advance(Duration::from_secs(95)).await;
    assert_eq!(
        client.response(opening).await["error"]["data"]["kind"],
        "stale_route"
    );
    assert_eq!(
        worker.method("$/cancel_request").await["params"]["requestId"],
        native_opening["id"]
    );
    let next = expect_result(client.response(next).await);
    assert_eq!(next["accountId"], "a");
    assert!(!worker.closed.is_cancelled());

    worker.reply(&native_opening, json!({"sessionId": "late-native-id"}));
    assert_eq!(
        worker.method("session/close").await["params"]["sessionId"],
        "late-native-id"
    );
    worker.reply(&prompt, json!({"stopReason": "end_turn"}));
    assert_eq!(
        expect_result(client.response(in_flight).await),
        json!({"stopReason": "end_turn"})
    );
    assert_eq!(
        worker
            .frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["method"] == "session/prompt")
            .count(),
        1
    );
    client.release(&live).await;
    client.release(&next).await;
}

#[tokio::test(start_paused = true)]
async fn detaches_timed_out_configuration_before_reusing_the_chat() {
    let (router, _, mut streams) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    let turn = client.acquire("chat").await;
    let session = client.open(&turn, json!([])).await;
    let worker = streams.try_recv().unwrap();
    let config = client.request("session/set_config_option", config_params(&turn, &session));
    let native = worker.method("session/set_config_option").await;
    advance(Duration::from_secs(60)).await;
    assert_eq!(
        client.response(config).await["error"]["data"]["kind"],
        "stale_route"
    );
    assert_eq!(
        worker.method("$/cancel_request").await["params"]["requestId"],
        native["id"]
    );
    assert_eq!(
        worker.method("session/close").await["params"]["sessionId"],
        NATIVE
    );
    client.release(&turn).await;
    let next = client.acquire("chat").await;
    assert_ne!(next["generationId"], turn["generationId"]);
    let reuse = client.request("session/prompt", prompt_params(&next, &session));
    assert_eq!(
        client.response(reuse).await["error"]["data"]["kind"],
        "stale_route"
    );
    assert!(
        !worker
            .frames
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame["method"] == "session/prompt")
    );
    client.release(&next).await;
}

#[tokio::test]
async fn rejects_rebinding_an_old_session_while_the_same_turn_is_opening_one() {
    let (router, _, mut streams) = harness();
    let mut client = Client::connect(&router, "dshA").await;
    let original = client.acquire("chat").await;
    let old_session = client.open(&original, json!([])).await;
    client.release(&original).await;
    let next = client.acquire("chat").await;

    let worker = streams.try_recv().unwrap();
    worker.pause_open.store(true, Ordering::SeqCst);
    let previous = worker.method("session/new").await;
    let opening = client.request("session/new", open_params(&next, json!([])));
    let native_opening = worker
        .frame(|frame| frame["method"] == "session/new" && frame["id"] != previous["id"])
        .await;
    let rejected = client.request("session/prompt", prompt_params(&next, &old_session));
    assert_eq!(client.response(rejected).await["error"]["code"], -32602);
    worker.reply(&native_opening, json!({"sessionId": "new-native-id"}));
    expect_result(client.response(opening).await);

    assert_eq!(
        client
            .result(
                "session/close",
                json!({"sessionId": old_session["sessionId"]})
            )
            .await,
        json!({})
    );
    assert_eq!(
        worker.method("session/close").await["params"]["sessionId"],
        NATIVE
    );
    client.release(&next).await;
}
