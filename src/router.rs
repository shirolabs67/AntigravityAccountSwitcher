use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::acp_backend::{AcpBackend, BackendError, RpcFault, RpcId, WorkerStream};
use crate::wire::PeerError;
use crate::worker::Quota;

const EXTENSION: &str = "antigravityAccountSwitcher";
const ACQUIRE: &str = "_antigravityAccountSwitcher/acquireTurn";
const RELEASE: &str = "_antigravityAccountSwitcher/releaseTurn";
const ACQUIRE_DEADLINE: Duration = Duration::from_secs(110);
const INITIALIZE_DEADLINE: Duration = Duration::from_secs(10);
const SESSION_NEW_DEADLINE: Duration = Duration::from_secs(90);
const SESSION_CONFIG_DEADLINE: Duration = Duration::from_secs(55);
const SESSION_CLOSE_DEADLINE: Duration = Duration::from_secs(10);
const DISCONNECT_GRACE: Duration = Duration::from_secs(30);
const MAX_QUEUED_FRAMES: usize = 64;
const MAX_PENDING_REQUESTS: usize = 512;

pub struct RouterConfig {
    pub accounts: Vec<String>,
    pub instances: HashMap<String, InstanceConfig>,
    pub model_groups: HashMap<String, String>,
    pub threshold: f64,
    pub exhausted_message: String,
}

pub struct InstanceConfig {
    pub mcp_port: u16,
    pub allow_account_switch: bool,
}

#[async_trait]
pub trait WorkerDirectory: Send + Sync {
    async fn probe(&self, account_id: &str, group_id: &str) -> Result<Quota, PeerError>;
    async fn open(&self, account_id: &str) -> Result<Arc<dyn WorkerStream>, PeerError>;
}

#[derive(Clone)]
pub struct RouterConnection {
    input: mpsc::Sender<Value>,
    shutdown: CancellationToken,
}

impl RouterConnection {
    pub fn receive(&self, frame: Value) -> Result<(), PeerError> {
        if self.shutdown.is_cancelled() || self.input.try_send(frame).is_err() {
            self.close();
            return Err(PeerError::new("disconnected"));
        }
        Ok(())
    }

    pub fn close(&self) {
        self.shutdown.cancel();
    }

    pub async fn closed(&self) {
        self.shutdown.cancelled().await;
    }
}

// 以认证实例和聊天为键，同一实例重连时也要等该聊天的旧租约释放。
type ChatKey = (String, String);
type Chats = Mutex<HashMap<ChatKey, watch::Sender<()>>>;

struct ChatLock {
    chats: Arc<Chats>,
    key: ChatKey,
}

impl ChatLock {
    fn try_acquire(chats: &Arc<Chats>, key: &ChatKey) -> Result<Self, watch::Receiver<()>> {
        let mut active = chats.lock().unwrap();
        match active.entry(key.clone()) {
            std::collections::hash_map::Entry::Occupied(slot) => Err(slot.get().subscribe()),
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(watch::channel(()).0);
                Ok(Self {
                    chats: chats.clone(),
                    key: key.clone(),
                })
            }
        }
    }
}

impl Drop for ChatLock {
    fn drop(&mut self) {
        // Dropping the sender wakes every waiter, which then competes for this key.
        self.chats.lock().unwrap().remove(&self.key);
    }
}

// 切号后，旧代际仍供已持有租约的轮次使用，最后一个租约释放才通知后端退出。
struct Generation {
    id: Uuid,
    account: String,
    draining: AtomicBool,
    leases: AtomicUsize,
    drained: CancellationToken,
}

impl Generation {
    fn new(account: String) -> Arc<Self> {
        Arc::new(Self {
            id: Uuid::new_v4(),
            account,
            draining: AtomicBool::new(false),
            leases: AtomicUsize::new(0),
            drained: CancellationToken::new(),
        })
    }

    fn retire(&self) {
        self.draining.store(true, Ordering::SeqCst);
        if self.leases.load(Ordering::SeqCst) == 0 {
            self.drained.cancel();
        }
    }
}

struct Lease {
    id: String,
    model: String,
    chat: String,
    // 整圈确认额度不足时使用无后端的租约，由路由器直接返回固定回复。
    generation: Option<Arc<Generation>>,
    _chat_lock: ChatLock,
    session: Option<String>,
    opening: bool,
    releasing: bool,
    operations: usize,
    permissions: usize,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(generation) = &self.generation
            && generation.leases.fetch_sub(1, Ordering::SeqCst) == 1
            && generation.draining.load(Ordering::SeqCst)
        {
            generation.drained.cancel();
        }
    }
}

#[derive(Default)]
struct Selection {
    current: Option<Arc<Generation>>,
    start: usize,
}

impl Selection {
    fn retire_current(&mut self) {
        if let Some(previous) = self.current.take() {
            previous.retire();
        }
    }
}

struct Routing {
    config: RouterConfig,
    workers: Arc<dyn WorkerDirectory>,
    chats: Arc<Chats>,
    selection: AsyncMutex<Selection>,
}

#[derive(Clone)]
pub struct Router(Arc<Routing>);

impl Router {
    pub fn new(config: RouterConfig, workers: Arc<dyn WorkerDirectory>) -> Self {
        Self(Arc::new(Routing {
            config,
            workers,
            chats: Arc::new(Mutex::new(HashMap::new())),
            selection: AsyncMutex::new(Selection::default()),
        }))
    }

    pub fn connect(
        &self,
        instance: &str,
        emit: impl Fn(Value) -> Result<(), PeerError> + Send + 'static,
    ) -> Result<RouterConnection, PeerError> {
        let config = self
            .0
            .config
            .instances
            .get(instance)
            .ok_or_else(|| PeerError::new("unknown_instance"))?;
        let (input, frames) = mpsc::channel(MAX_QUEUED_FRAMES);
        let (events, receiver) = mpsc::channel(MAX_QUEUED_FRAMES);
        let shutdown = CancellationToken::new();
        let connection = Connection {
            router: self.clone(),
            instance: instance.into(),
            port: config.mcp_port,
            allow_account_switch: config.allow_account_switch,
            emit: Box::new(emit),
            events,
            shutdown: shutdown.clone(),
            initialized: None,
            leases: HashMap::new(),
            sessions: HashMap::new(),
            backends: HashMap::new(),
            revisions: HashMap::new(),
            incoming: HashMap::new(),
            permissions: HashMap::new(),
            closed: false,
        };
        tokio::spawn(connection.run(frames, receiver));
        Ok(RouterConnection { input, shutdown })
    }

    fn start_acquire(
        &self,
        instance: &str,
        chat: &str,
        model: &str,
        switch_account: bool,
    ) -> Result<impl Future<Output = Result<Lease, RpcFault>> + Send + 'static + use<>, RpcFault>
    {
        let group = self
            .0
            .config
            .model_groups
            .get(model)
            .cloned()
            .ok_or_else(|| invalid("No quota group is configured for the requested model"))?;
        let key = (instance.to_owned(), chat.to_owned());
        let model = model.to_owned();
        let router = self.clone();
        // Reserve a free chat in connection arrival order before yielding to a probe.
        let mut lock = ChatLock::try_acquire(&router.0.chats, &key);
        Ok(async move {
            let lock = loop {
                match lock {
                    Ok(lock) => break lock,
                    Err(mut released) => {
                        let _ = released.changed().await;
                        lock = ChatLock::try_acquire(&router.0.chats, &key);
                    }
                }
            };
            router
                .select_account(key.1, model, &group, switch_account, lock)
                .await
        })
    }

    async fn select_account(
        &self,
        chat: String,
        model: String,
        group: &str,
        switch_account: bool,
        chat_lock: ChatLock,
    ) -> Result<Lease, RpcFault> {
        let routing = &self.0;
        // 串行完成额度探测、当前账号更新和租约登记，确保一次准入观察到同一个轮询起点。
        let mut selection = routing.selection.lock().await;
        if switch_account && selection.current.is_none() {
            return Err(RpcFault::new(
                -32044,
                "Establish a current account with a normal turn before requesting a switch",
                Some(json!({"kind": "account_switch_unavailable", "reason": "no_current_account"})),
            ));
        }
        let mut unknown = Vec::new();
        let accounts = &routing.config.accounts;
        // 主动换号跳过当前账号，仍按配置顺序探测备选账号并执行相同的额度校验。
        for offset in usize::from(switch_account)..accounts.len() {
            let index = (selection.start + offset) % accounts.len();
            let account = &accounts[index];
            let failure = match routing.workers.probe(account, group).await {
                Ok(quota) if valid_fraction(quota.weekly) && valid_fraction(quota.five_hour) => {
                    if quota.weekly.min(quota.five_hour) < routing.config.threshold {
                        continue;
                    }
                    selection.start = index;
                    if selection
                        .current
                        .as_ref()
                        .is_none_or(|item| item.account != *account)
                    {
                        selection.retire_current();
                        selection.current = Some(Generation::new(account.clone()));
                    }
                    let generation = selection.current.as_ref().unwrap().clone();
                    // Register the lease before another acquisition can switch accounts.
                    generation.leases.fetch_add(1, Ordering::SeqCst);
                    return Ok(new_lease(chat, model, Some(generation), chat_lock));
                }
                Ok(_) => "invalid_quota",
                Err(error) => quota_failure(error.category()),
            };
            unknown.push(json!({"accountId": account, "reason": failure}));
        }
        if switch_account {
            // 备选账号均不可用时，保留当前账号供普通轮次继续申请。
            return Err(RpcFault::new(
                -32044,
                "No alternate account meets the quota requirements",
                Some(json!({"kind": "account_switch_unavailable", "accounts": unknown})),
            ));
        }
        if !unknown.is_empty() {
            return Err(RpcFault::new(
                -32040,
                "No eligible account could be confirmed",
                Some(json!({"kind": "quota_unknown", "accounts": unknown})),
            ));
        }
        selection.retire_current();
        Ok(new_lease(chat, model, None, chat_lock))
    }
}

fn new_lease(
    chat: String,
    model: String,
    generation: Option<Arc<Generation>>,
    chat_lock: ChatLock,
) -> Lease {
    Lease {
        id: new_id(),
        model,
        chat,
        generation,
        _chat_lock: chat_lock,
        session: None,
        opening: false,
        releasing: false,
        operations: 0,
        permissions: 0,
    }
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn valid_fraction(value: f64) -> bool {
    (0.0..=1.0).contains(&value)
}

fn quota_failure(category: &str) -> &'static str {
    match category {
        "login_required" | "quota_auth" => "login_required",
        "timeout" | "quota_timeout" => "timeout",
        "invalid_quota" | "quota_invalid" => "invalid_quota",
        "worker_unavailable" | "worker_offline" | "disconnected" => "worker_unavailable",
        _ => "probe_failed",
    }
}

fn invalid(message: &'static str) -> RpcFault {
    RpcFault::new(-32602, message, None)
}

fn stale(message: &'static str) -> RpcFault {
    RpcFault::new(-32042, message, Some(json!({"kind": "stale_route"})))
}

fn cancelled() -> RpcFault {
    RpcFault::new(-32800, "Request cancelled", None)
}

fn cancelled_permission() -> Value {
    json!({"result": {"outcome": {"outcome": "cancelled"}}})
}

fn lease_meta(params: &Value) -> Option<&Value> {
    params.get("_meta")?.get(EXTENSION)?.get("leaseId")
}

fn without_extension(mut params: Value) -> Value {
    if let Some(meta) = params.get_mut("_meta").and_then(Value::as_object_mut)
        && meta.remove(EXTENSION).is_some()
        && meta.is_empty()
    {
        params.as_object_mut().unwrap().remove("_meta");
    }
    params
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_bridge_url(url: &str) -> Option<&str> {
    let (port, path) = url.strip_prefix("http://127.0.0.1:")?.split_once("/mcp/")?;
    if port.is_empty()
        || port.starts_with('0')
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().is_err()
        || !valid_hex(path, 32)
    {
        return None;
    }
    Some(path)
}

fn mcp_servers(raw: &Value, port: u16) -> Result<Value, RpcFault> {
    let bridges = raw
        .as_array()
        .filter(|bridges| bridges.len() <= 1)
        .ok_or_else(|| invalid("Expected zero or one DSH MCP bridge"))?;
    let Some(bridge) = bridges.first() else {
        return Ok(json!([]));
    };
    let url = bridge.get("url").and_then(Value::as_str);
    if bridge["type"] != "http" || bridge["name"] != "dsh" || url.is_none() {
        return Err(invalid("Only the DSH HTTP MCP bridge is supported"));
    }
    let headers = &bridge["headers"];
    let authorization = headers.as_array().filter(|items| items.len() == 1);
    let bearer = authorization
        .map(|items| &items[0])
        .filter(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("authorization"))
        })
        .and_then(|item| item["value"].as_str())
        .and_then(|value| value.strip_prefix("Bearer "));
    let path = url
        .and_then(valid_bridge_url)
        .filter(|_| bearer.is_some_and(|value| valid_hex(value, 48)))
        .ok_or_else(|| invalid("Invalid DSH MCP bridge address or authorization format"))?;
    // 目标端口来自认证实例的 SSH 反向转发配置，沿用插件生成的路径和鉴权头。
    Ok(json!([{
        "type": "http",
        "name": "dsh",
        "url": format!("http://127.0.0.1:{port}/mcp/{path}"),
        "headers": headers,
    }]))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SlotKey {
    generation: Uuid,
    // 同一代际可能重新连接后端，独立标识防止旧连接的迟到事件作用于新连接。
    id: Uuid,
}

struct Session {
    native: String,
    slot: Option<SlotKey>,
    chat: String,
    generation: Option<Uuid>,
    lease: Option<String>,
    model: Option<String>,
    model_config: Option<String>,
    prompting: bool,
}

impl Session {
    fn observe_model(&mut self, value: &Value) {
        let option = value["configOptions"].as_array().and_then(|options| {
            options
                .iter()
                .find(|option| option["id"] == "model" || option["category"] == "model")
        });
        if let Some(id) = option.and_then(|option| option["id"].as_str()) {
            self.model_config = Some(id.into());
        }
        let current = option
            .map(|option| &option["currentValue"])
            .filter(|value| !value.is_null())
            .unwrap_or(&value["models"]["currentModelId"]);
        if let Some(model) = current.as_str() {
            self.model = Some(model.into());
        }
    }
}

struct Permission {
    native: RpcId,
    slot: SlotKey,
    session: String,
    lease: String,
}

struct Opening {
    request: RpcId,
    lease: String,
    params: Value,
}

enum SlotState {
    Starting,
    Initializing(Arc<AcpBackend>),
    Ready(Arc<AcpBackend>),
}

struct BackendSlot {
    key: SlotKey,
    generation: Arc<Generation>,
    state: SlotState,
    sessions: HashMap<String, String>,
    permissions: HashMap<RpcId, String>,
    openings: Vec<Opening>,
    stopped: CancellationToken,
}

impl BackendSlot {
    fn backend(&self) -> Option<&Arc<AcpBackend>> {
        match &self.state {
            SlotState::Starting => None,
            SlotState::Initializing(backend) | SlotState::Ready(backend) => Some(backend),
        }
    }
}

enum Operation {
    Open { lease: String },
    Session(SessionOperation),
    Close,
}

struct SessionOperation {
    lease: String,
    session: String,
    native: String,
    prompting: bool,
}

enum Event {
    Acquired(RpcId, Result<Lease, RpcFault>),
    StreamOpened(SlotKey, Result<UnclaimedStream, PeerError>),
    Initialized(SlotKey, Result<Value, BackendError>),
    BackendClosed(SlotKey),
    Drained(SlotKey),
    WorkerFrame(SlotKey, Value),
    LateSession(SlotKey, Value),
    Completed(SlotKey, RpcId, Operation, Result<Value, BackendError>),
}

// 每条认证连接的会话、租约和请求映射由同一事件循环维护。
struct Connection {
    router: Router,
    instance: String,
    port: u16,
    allow_account_switch: bool,
    emit: Box<dyn Fn(Value) -> Result<(), PeerError> + Send>,
    events: mpsc::Sender<Event>,
    shutdown: CancellationToken,
    initialized: Option<Value>,
    leases: HashMap<String, Lease>,
    sessions: HashMap<String, Session>,
    backends: HashMap<Uuid, BackendSlot>,
    revisions: HashMap<Uuid, (Weak<Generation>, String)>,
    incoming: HashMap<RpcId, CancellationToken>,
    permissions: HashMap<String, Permission>,
    closed: bool,
}

impl Connection {
    async fn run(mut self, mut frames: mpsc::Receiver<Value>, mut events: mpsc::Receiver<Event>) {
        let mut close_deadline = None;
        loop {
            if self.shutdown.is_cancelled() && !self.closed {
                self.begin_close();
                close_deadline = Some(Instant::now() + DISCONNECT_GRACE);
            }
            if self.closed {
                self.close_idle_backends();
                if self.leases.is_empty() {
                    break;
                }
            }
            tokio::select! {
                _ = self.shutdown.cancelled(), if !self.closed => {},
                frame = frames.recv(), if !self.closed => match frame {
                    Some(frame) => self.receive(frame),
                    None => self.shutdown.cancel(),
                },
                Some(event) = events.recv() => self.handle_event(event),
                _ = sleep_until(close_deadline.unwrap_or_else(Instant::now)), if close_deadline.is_some() => break,
            }
        }
        self.shutdown.cancel();
        for (_, slot) in self.backends.drain() {
            slot.stopped.cancel();
            if let Some(backend) = slot.backend() {
                backend.close();
            }
        }
    }

    fn receive(&mut self, frame: Value) {
        if frame["jsonrpc"] != "2.0" {
            return;
        }
        let id = RpcId::from_value(&frame["id"]);
        let Some(method) = frame["method"].as_str() else {
            if let Some(RpcId::String(id)) = id {
                self.answer_permission(&id, &frame);
            }
            return;
        };
        let params = frame
            .get("params")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let Some(id) = id else {
            if frame.get("id").is_none() {
                self.notification(method, &params);
            } else {
                self.send(RpcFault::new(-32600, "Invalid request ID", None).frame(None));
            }
            return;
        };
        // Replying twice with the same ID could resolve the original request.
        if self.incoming.contains_key(&id) {
            return;
        }
        if self.incoming.len() >= MAX_PENDING_REQUESTS {
            self.shutdown.cancel();
            return;
        }
        let signal = CancellationToken::new();
        self.incoming.insert(id.clone(), signal.clone());
        match self.request(&id, method, params, signal) {
            Ok(Some(result)) => self.complete(id, Ok(result)),
            Err(error) => self.complete(id, Err(error)),
            Ok(None) => {}
        }
    }

    fn request(
        &mut self,
        id: &RpcId,
        method: &str,
        params: Value,
        signal: CancellationToken,
    ) -> Result<Option<Value>, RpcFault> {
        if method == "initialize" {
            return self.initialize(&params).map(Some);
        }
        if self.initialized.is_none() {
            return Err(RpcFault::new(
                -32002,
                "Initialize the ACP connection first",
                None,
            ));
        }
        match method {
            ACQUIRE => {
                self.acquire_turn(id.clone(), &params, signal)?;
                Ok(None)
            }
            RELEASE => {
                let lease = params["leaseId"]
                    .as_str()
                    .ok_or_else(|| invalid("leaseId is required"))?;
                self.begin_release(lease);
                Ok(Some(json!({})))
            }
            "session/new" => self.open_session(id.clone(), params),
            "session/close" => self.close_session(id.clone(), &params, signal),
            "session/prompt" | "session/set_config_option" => {
                self.session_request(id.clone(), method, params, signal)
            }
            _ => Err(RpcFault::new(
                -32601,
                "ACP method is not supported by this router",
                None,
            )),
        }
    }

    fn initialize(&mut self, params: &Value) -> Result<Value, RpcFault> {
        if params["protocolVersion"].as_f64() != Some(1.0) {
            return Err(invalid("ACP protocol version 1 is required"));
        }
        if self.initialized.is_some() {
            return Err(invalid("ACP connection is already initialized"));
        }
        let mut backend_init = json!({"protocolVersion": 1, "clientCapabilities": {}});
        if let Some(client_info) = params.get("clientInfo") {
            backend_init["clientInfo"] = client_info.clone();
        }
        self.initialized = Some(backend_init);
        let mut capability = json!({(EXTENSION): {"version": 1}});
        if self.allow_account_switch {
            capability[EXTENSION]["switchAccount"] = json!(true);
        }
        Ok(json!({
            "protocolVersion": 1,
            "agentInfo": {"name": "Antigravity Account Switcher", "version": env!("CARGO_PKG_VERSION")},
            "authMethods": [],
            "agentCapabilities": {
                "loadSession": false,
                "mcpCapabilities": {"http": true},
                "sessionCapabilities": {"close": {}},
                "promptCapabilities": {"image": true},
                "_meta": capability,
            },
            "_meta": capability,
        }))
    }

    fn acquire_turn(
        &self,
        id: RpcId,
        params: &Value,
        signal: CancellationToken,
    ) -> Result<(), RpcFault> {
        let chat = params["chatKey"]
            .as_str()
            .filter(|chat| !chat.trim().is_empty() && chat.encode_utf16().count() <= 1024);
        let model = params["model"]
            .as_str()
            .filter(|model| !model.trim().is_empty());
        let (Some(chat), Some(model)) = (chat, model) else {
            return Err(invalid("chatKey and model are required"));
        };
        let switch_account = match params["_meta"][EXTENSION].get("switchAccount") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| invalid("switchAccount must be a boolean"))?,
        };
        // 初始化能力只告知客户端是否支持换号，准入时仍按认证实例的配置校验授权。
        if switch_account && !self.allow_account_switch {
            return Err(RpcFault::new(
                -32043,
                "Account switching is disabled for this DSH instance",
                Some(json!({"kind": "account_switch_disabled"})),
            ));
        }
        let pending = self
            .router
            .start_acquire(&self.instance, chat, model, switch_account)?;
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                biased;
                _ = signal.cancelled() => Err(cancelled()),
                _ = sleep(ACQUIRE_DEADLINE) => Err(RpcFault::new(
                    -32040,
                    "Account selection timed out",
                    Some(json!({"kind": "quota_unknown", "reason": "timeout"})),
                )),
                result = pending => result,
            };
            let _ = events.send(Event::Acquired(id, result)).await;
        });
        Ok(())
    }

    fn acquired(&mut self, request: RpcId, result: Result<Lease, RpcFault>) {
        let result = result.and_then(|lease| {
            if self.closed || self.incoming[&request].is_cancelled() {
                return Err(cancelled());
            }
            self.revisions
                .retain(|_, (generation, _)| generation.strong_count() != 0);
            let reply = match &lease.generation {
                None => {
                    json!({"status": "exhausted", "leaseId": lease.id, "generationId": "exhausted"})
                }
                Some(generation) => {
                    // 当前代际的后端失效后，向此连接公布新标识，提示插件按 DSH 历史重建会话。
                    let revision = self
                        .revisions
                        .get(&generation.id)
                        .map_or_else(|| generation.id.to_string(), |(_, id)| id.clone());
                    json!({
                        "status": "selected", "leaseId": lease.id, "accountId": generation.account,
                        "generationId": revision,
                    })
                }
            };
            self.leases.insert(lease.id.clone(), lease);
            Ok(reply)
        });
        self.complete(request, result);
    }

    fn require_lease(&self, params: &Value) -> Result<&Lease, RpcFault> {
        lease_meta(params)
            .and_then(Value::as_str)
            .and_then(|id| self.leases.get(id))
            .filter(|lease| !lease.releasing)
            .ok_or_else(|| stale("Turn lease is missing or expired"))
    }

    fn open_session(
        &mut self,
        request: RpcId,
        mut params: Value,
    ) -> Result<Option<Value>, RpcFault> {
        let lease = self.require_lease(&params)?;
        if lease.opening || lease.session.is_some() {
            return Err(stale("Turn lease already has a session"));
        }
        if params.get("additionalDirectories").is_some() {
            return Err(invalid("Client directories are not supported"));
        }
        let servers = mcp_servers(&params["mcpServers"], self.port)?;
        let lease_id = lease.id.clone();
        let Some(generation) = lease.generation.clone() else {
            let id = self.attach_session(&lease_id, None, new_id());
            return Ok(Some(json!({"sessionId": id, "configOptions": []})));
        };

        let lease = self.leases.get_mut(&lease_id).unwrap();
        lease.opening = true;
        lease.operations += 1;
        params["mcpServers"] = servers;
        let opening = Opening {
            request,
            lease: lease_id,
            params: without_extension(params),
        };
        let slot = self.backend_slot(generation);
        let key = slot.key;
        if let SlotState::Ready(backend) = &slot.state {
            let backend = backend.clone();
            self.start_session_open(key, backend, opening);
        } else {
            slot.openings.push(opening);
        }
        Ok(None)
    }

    fn start_session_open(&mut self, key: SlotKey, backend: Arc<AcpBackend>, opening: Opening) {
        let Opening {
            request,
            lease,
            params,
        } = opening;
        let signal = self.incoming[&request].clone();
        let error = if signal.is_cancelled() {
            Some(cancelled())
        } else if self.leases[&lease].releasing {
            Some(stale("Turn lease is no longer active"))
        } else {
            None
        };
        if let Some(error) = error {
            self.complete_open(request, &lease, Err(error));
            return;
        }
        let events = self.events.clone();
        let shutdown = self.shutdown.clone();
        let on_late_result = Box::new(move |result| {
            queue_event(&events, &shutdown, Event::LateSession(key, result));
        });
        let pending = backend.request(
            "session/new",
            params,
            Some(signal),
            Some(SESSION_NEW_DEADLINE),
            Some(on_late_result),
        );
        self.wait_for_request(key, request, Operation::Open { lease }, pending);
    }

    fn attach_session(&mut self, lease_id: &str, slot: Option<SlotKey>, native: String) -> String {
        let id = new_id();
        let lease = self.leases.get_mut(lease_id).unwrap();
        let session = Session {
            native: native.clone(),
            slot,
            chat: lease.chat.clone(),
            generation: lease.generation.as_ref().map(|route| route.id),
            lease: Some(lease_id.into()),
            model: None,
            model_config: None,
            prompting: false,
        };
        lease.session = Some(id.clone());
        self.sessions.insert(id.clone(), session);
        if let Some(key) = slot {
            self.slot_mut(key)
                .unwrap()
                .sessions
                .insert(native, id.clone());
        }
        id
    }

    fn detach_session(&mut self, id: &str) -> Option<Session> {
        let session = self.sessions.remove(id)?;
        if let Some(slot) = session.slot.and_then(|key| self.slot_mut(key)) {
            slot.sessions.remove(&session.native);
        }
        if let Some(lease) = session
            .lease
            .as_ref()
            .and_then(|id| self.leases.get_mut(id))
            && lease.session.as_deref() == Some(id)
        {
            lease.session = None;
        }
        Some(session)
    }

    fn bind_session(&mut self, params: &Value) -> Result<(String, String), RpcFault> {
        let session_id = params["sessionId"].as_str().unwrap_or("");
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| stale("Unknown or expired ACP session"))?;
        let lease = self.require_lease(params)?;
        // 同一聊天在同一代际中才能复用会话，租约与会话保持一对一绑定。
        if session.chat != lease.chat
            || session.generation != lease.generation.as_ref().map(|route| route.id)
            || lease.session.as_deref().is_some_and(|id| id != session_id)
            || session.lease.as_ref().is_some_and(|id| id != &lease.id)
        {
            return Err(stale("ACP session does not belong to this turn lease"));
        }
        if lease.operations != 0 {
            return Err(invalid("An ACP operation is already active for this turn"));
        }
        let lease_id = lease.id.clone();
        self.sessions.get_mut(session_id).unwrap().lease = Some(lease_id.clone());
        self.leases.get_mut(&lease_id).unwrap().session = Some(session_id.into());
        Ok((session_id.into(), lease_id))
    }

    fn close_session(
        &mut self,
        request: RpcId,
        params: &Value,
        signal: CancellationToken,
    ) -> Result<Option<Value>, RpcFault> {
        let id = params["sessionId"]
            .as_str()
            .ok_or_else(|| invalid("sessionId is required"))?;
        let Some(session) = self.sessions.get(id) else {
            return Ok(Some(json!({})));
        };
        if let Some(lease) = session.lease.as_ref().and_then(|id| self.leases.get(id))
            && (lease.operations > 0
                || lease.permissions > 0
                || lease_meta(params).and_then(Value::as_str) != Some(&lease.id))
        {
            return Err(stale("ACP session has an active turn"));
        }
        let session = self.detach_session(id).unwrap();
        let Some(key) = session.slot else {
            return Ok(Some(json!({})));
        };
        let Some(backend) = self.available_backend(key) else {
            return Ok(Some(json!({})));
        };
        let pending = backend.request(
            "session/close",
            json!({"sessionId": session.native}),
            Some(signal),
            Some(SESSION_CLOSE_DEADLINE),
            None,
        );
        self.wait_for_request(key, request, Operation::Close, pending);
        Ok(None)
    }

    fn session_request(
        &mut self,
        request: RpcId,
        method: &str,
        params: Value,
        signal: CancellationToken,
    ) -> Result<Option<Value>, RpcFault> {
        let (session_id, lease_id) = self.bind_session(&params)?;
        let session = &self.sessions[&session_id];
        let lease = &self.leases[&lease_id];
        let prompting = method == "session/prompt";
        if prompting {
            if !params["prompt"].is_array() {
                return Err(invalid("Prompt content must be an array"));
            }
            if session
                .model
                .as_ref()
                .is_some_and(|model| !model.is_empty() && model != &lease.model)
            {
                return Err(invalid("Select the quota-checked model before prompting"));
            }
        } else {
            let (Some(config_id), Some(value)) =
                (params["configId"].as_str(), params["value"].as_str())
            else {
                return Err(invalid("configId and value are required"));
            };
            if (config_id == "model" || session.model_config.as_deref() == Some(config_id))
                && value != lease.model
            {
                return Err(invalid(
                    "Model selection differs from the quota-checked model",
                ));
            }
        }
        let Some(key) = session.slot else {
            if !prompting {
                return Ok(Some(json!({"configOptions": []})));
            }
            self.send(json!({
                "jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {
                        "type": "text", "text": self.router.0.config.exhausted_message,
                    }},
                }
            }));
            return Ok(Some(json!({"stopReason": "end_turn"})));
        };
        let backend = self
            .available_backend(key)
            .ok_or_else(|| stale("Account worker is unavailable"))?;
        let native = session.native.clone();
        self.leases.get_mut(&lease_id).unwrap().operations += 1;
        self.sessions.get_mut(&session_id).unwrap().prompting = prompting;
        let mut params = without_extension(params);
        params["sessionId"] = json!(native);
        let pending = backend.request(
            method,
            params,
            Some(signal),
            (!prompting).then_some(SESSION_CONFIG_DEADLINE),
            None,
        );
        self.wait_for_request(
            key,
            request,
            Operation::Session(SessionOperation {
                lease: lease_id,
                session: session_id,
                native,
                prompting,
            }),
            pending,
        );
        Ok(None)
    }
}

struct UnclaimedStream(Option<Arc<dyn WorkerStream>>);

impl Drop for UnclaimedStream {
    fn drop(&mut self) {
        if let Some(stream) = self.0.take() {
            stream.close();
        }
    }
}

fn queue_event(events: &mpsc::Sender<Event>, shutdown: &CancellationToken, event: Event) {
    if events.try_send(event).is_err() {
        shutdown.cancel();
    }
}

fn setup_fault(error: BackendError) -> RpcFault {
    match error {
        BackendError::Timeout => stale("Account worker timed out during ACP session setup"),
        BackendError::Disconnected => {
            stale("Account worker disconnected before session setup finished")
        }
        BackendError::Fault(fault) => fault,
    }
}

impl Connection {
    fn backend_slot(&mut self, generation: Arc<Generation>) -> &mut BackendSlot {
        self.backends.entry(generation.id).or_insert_with(|| {
            let key = SlotKey {
                generation: generation.id,
                id: Uuid::new_v4(),
            };
            let stopped = CancellationToken::new();
            let workers = self.router.0.workers.clone();
            let account = generation.account.clone();
            let events = self.events.clone();
            let opening_stopped = stopped.clone();
            tokio::spawn(async move {
                let result = workers
                    .open(&account)
                    .await
                    .map(|stream| UnclaimedStream(Some(stream)));
                if !opening_stopped.is_cancelled() {
                    let _ = events.send(Event::StreamOpened(key, result)).await;
                }
            });
            let events = self.events.clone();
            let draining_stopped = stopped.clone();
            let drained = generation.drained.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = draining_stopped.cancelled() => {},
                    _ = drained.cancelled() => {
                        let _ = events.send(Event::Drained(key)).await;
                    }
                }
            });
            BackendSlot {
                key,
                generation,
                state: SlotState::Starting,
                sessions: HashMap::new(),
                permissions: HashMap::new(),
                openings: Vec::new(),
                stopped,
            }
        })
    }

    fn slot(&self, key: SlotKey) -> Option<&BackendSlot> {
        self.backends
            .get(&key.generation)
            .filter(|slot| slot.key == key)
    }

    fn slot_mut(&mut self, key: SlotKey) -> Option<&mut BackendSlot> {
        self.backends
            .get_mut(&key.generation)
            .filter(|slot| slot.key == key)
    }

    fn available_backend(&self, key: SlotKey) -> Option<Arc<AcpBackend>> {
        self.slot(key)?
            .backend()
            .filter(|backend| !backend.closed())
            .cloned()
    }

    fn stream_opened(&mut self, key: SlotKey, result: Result<UnclaimedStream, PeerError>) {
        if self.slot(key).is_none() {
            return;
        }
        if self.closed {
            self.end_slot(key, cancelled);
            return;
        }
        let Ok(mut unclaimed) = result else {
            self.end_slot(key, || stale("Account worker could not be started"));
            return;
        };
        let frame_events = self.events.clone();
        let frame_shutdown = self.shutdown.clone();
        let exit_events = self.events.clone();
        let exit_shutdown = self.shutdown.clone();
        let backend = AcpBackend::new(
            unclaimed.0.take().unwrap(),
            move |frame| {
                queue_event(
                    &frame_events,
                    &frame_shutdown,
                    Event::WorkerFrame(key, frame),
                )
            },
            move || queue_event(&exit_events, &exit_shutdown, Event::BackendClosed(key)),
        );
        self.slot_mut(key).unwrap().state = SlotState::Initializing(backend.clone());
        if backend.closed() {
            self.end_slot(key, || stale("Account worker could not be initialized"));
            return;
        }
        let pending = backend.request(
            "initialize",
            self.initialized.clone().unwrap_or_else(|| json!({})),
            None,
            Some(INITIALIZE_DEADLINE),
            None,
        );
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = pending.await;
            let _ = events.send(Event::Initialized(key, result)).await;
        });
    }

    fn initialized(&mut self, key: SlotKey, result: Result<Value, BackendError>) {
        let Some(slot) = self.slot_mut(key) else {
            return;
        };
        let SlotState::Initializing(backend) = &slot.state else {
            return;
        };
        let backend = backend.clone();
        let fault = match result {
            Ok(value) if value["protocolVersion"].as_f64() == Some(1.0) && !backend.closed() => {
                None
            }
            Ok(_) => Some(stale("Account worker did not negotiate ACP v1")),
            Err(error) => Some(setup_fault(error)),
        };
        if let Some(fault) = fault {
            self.end_slot(key, || {
                RpcFault::new(fault.code, fault.message.clone(), fault.data.clone())
            });
            return;
        }
        slot.state = SlotState::Ready(backend.clone());
        for opening in std::mem::take(&mut slot.openings) {
            self.start_session_open(key, backend.clone(), opening);
        }
    }

    fn end_slot(&mut self, key: SlotKey, failure: impl Fn() -> RpcFault) {
        if self.slot(key).is_none() {
            return;
        }
        let slot = self.backends.remove(&key.generation).unwrap();
        slot.stopped.cancel();
        if let Some(backend) = slot.backend() {
            if !slot.generation.draining.load(Ordering::SeqCst) {
                self.revise(&slot.generation);
            }
            backend.close();
        }
        for opening in slot.openings {
            self.complete_open(opening.request, &opening.lease, Err(failure()));
        }
        for permission in slot.permissions.values() {
            self.answer_permission(permission, &Value::Null);
        }
        for session in slot.sessions.values() {
            self.detach_session(session);
        }
    }

    fn revise(&mut self, generation: &Arc<Generation>) {
        self.revisions
            .insert(generation.id, (Arc::downgrade(generation), new_id()));
    }

    fn wait_for_request(
        &self,
        key: SlotKey,
        request: RpcId,
        operation: Operation,
        pending: impl Future<Output = Result<Value, BackendError>> + Send + 'static,
    ) {
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = pending.await;
            let _ = events
                .send(Event::Completed(key, request, operation, result))
                .await;
        });
    }

    fn handle_event(&mut self, event: Event) {
        match event {
            Event::Acquired(id, result) => self.acquired(id, result),
            Event::StreamOpened(key, result) => self.stream_opened(key, result),
            Event::Initialized(key, result) => self.initialized(key, result),
            Event::BackendClosed(key) => {
                self.end_slot(key, || setup_fault(BackendError::Disconnected))
            }
            Event::Drained(key) => self.end_slot(key, || stale("Account route has expired")),
            Event::WorkerFrame(key, frame) => self.worker_frame(key, frame),
            Event::LateSession(key, result) => {
                if let Some(id) = result["sessionId"].as_str().filter(|id| !id.is_empty())
                    && self
                        .slot(key)
                        .is_some_and(|slot| !slot.sessions.contains_key(id))
                {
                    self.discard_session(key, id);
                }
            }
            Event::Completed(key, id, operation, result) => {
                if matches!(result, Err(BackendError::Disconnected)) {
                    self.end_slot(key, || setup_fault(BackendError::Disconnected));
                }
                match operation {
                    Operation::Open { lease } => {
                        let result = result
                            .map_err(setup_fault)
                            .and_then(|result| self.opened(key, &id, &lease, result));
                        self.complete_open(id, &lease, result);
                    }
                    Operation::Session(operation) => {
                        self.complete_session(key, id, operation, result);
                    }
                    Operation::Close => {
                        let result = match result {
                            Ok(_) | Err(BackendError::Disconnected | BackendError::Timeout) => {
                                Ok(json!({}))
                            }
                            Err(BackendError::Fault(fault)) if fault.code == -32601 => {
                                Ok(json!({}))
                            }
                            Err(BackendError::Fault(fault)) => Err(fault),
                        };
                        self.complete(id, result);
                    }
                }
            }
        }
    }

    fn opened(
        &mut self,
        key: SlotKey,
        request: &RpcId,
        lease: &str,
        mut result: Value,
    ) -> Result<Value, RpcFault> {
        let native = result["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| RpcFault::new(-32603, "Invalid native ACP session ID", None))?;
        if self
            .slot(key)
            .is_some_and(|slot| slot.sessions.contains_key(native))
        {
            return Err(RpcFault::new(-32603, "Invalid native ACP session ID", None));
        }
        if self.available_backend(key).is_none() {
            return Err(setup_fault(BackendError::Disconnected));
        }
        if self.closed || self.incoming[request].is_cancelled() || self.leases[lease].releasing {
            self.discard_session(key, native);
            return Err(cancelled());
        }
        let native = native.to_owned();
        let session = self.attach_session(lease, Some(key), native.clone());
        self.sessions
            .get_mut(&session)
            .unwrap()
            .observe_model(&result);
        // ACP 使用代理会话 ID，DSH 的 MCP 桥用原生 ID 校验 agy 发起的调用。
        result["sessionId"] = json!(session);
        if !result["_meta"].is_object() {
            result["_meta"] = json!({});
        }
        result["_meta"][EXTENSION] = json!({"nativeSessionId": native});
        Ok(result)
    }

    fn discard_session(&self, key: SlotKey, native: &str) {
        if let Some(backend) = self.available_backend(key) {
            let pending = backend.request(
                "session/close",
                json!({"sessionId": native}),
                None,
                Some(SESSION_CLOSE_DEADLINE),
                None,
            );
            tokio::spawn(async move {
                let _ = pending.await;
            });
        }
    }

    fn complete_open(&mut self, request: RpcId, lease: &str, result: Result<Value, RpcFault>) {
        self.leases.get_mut(lease).unwrap().opening = false;
        self.finish_operation(lease);
        self.complete(request, result);
    }

    fn complete_session(
        &mut self,
        key: SlotKey,
        request: RpcId,
        operation: SessionOperation,
        result: Result<Value, BackendError>,
    ) {
        let SessionOperation {
            lease,
            session,
            native,
            prompting,
        } = operation;
        let result = match result {
            Ok(value) => {
                if !prompting && let Some(session) = self.sessions.get_mut(&session) {
                    session.observe_model(&value);
                }
                Ok(value)
            }
            Err(BackendError::Timeout) => {
                // A late model change cannot affect a session reused by a different turn.
                self.detach_session(&session);
                self.discard_session(key, &native);
                if let Some(generation) = self.leases[&lease].generation.clone() {
                    self.revise(&generation);
                }
                Err(stale(
                    "Account worker timed out configuring the ACP session",
                ))
            }
            // 已提交的 prompt 可能执行过工具，断线后用专用错误让插件终止本轮。
            Err(BackendError::Disconnected) if prompting => Err(submission_unknown()),
            Err(BackendError::Fault(fault))
                if prompting && fault.code == -32603 && self.available_backend(key).is_none() =>
            {
                Err(submission_unknown())
            }
            Err(BackendError::Disconnected) => Err(stale("Account worker is unavailable")),
            Err(BackendError::Fault(fault)) => Err(fault),
        };
        if let Some(session) = self.sessions.get_mut(&session) {
            session.prompting = false;
        }
        self.finish_operation(&lease);
        self.complete(request, result);
    }

    fn finish_operation(&mut self, lease: &str) {
        self.leases.get_mut(lease).unwrap().operations -= 1;
        self.finish_release(lease);
    }

    fn notification(&mut self, method: &str, params: &Value) {
        if method == "$/cancel_request" {
            if let Some(signal) =
                RpcId::from_value(&params["requestId"]).and_then(|id| self.incoming.get(&id))
            {
                signal.cancel();
            }
        } else if method == "session/cancel" {
            let Some(id) = params["sessionId"].as_str() else {
                return;
            };
            let Some(session) = self.sessions.get(id).filter(|session| session.prompting) else {
                return;
            };
            // The plugin may cancel on disposal before attaching lease metadata.
            if let Some(supplied) = lease_meta(params)
                && (supplied.as_str() != session.lease.as_deref() || !supplied.is_string())
            {
                return;
            }
            self.cancel_session(id);
        }
    }

    fn cancel_session(&mut self, id: &str) {
        let Some(session) = self.sessions.get(id) else {
            return;
        };
        if let Some(backend) = session.slot.and_then(|slot| self.available_backend(slot)) {
            backend.notify("session/cancel", json!({"sessionId": session.native}));
        }
        let permissions = self
            .permissions
            .iter()
            .filter(|(_, permission)| permission.session == id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in permissions {
            self.answer_permission(&id, &cancelled_permission());
        }
    }

    fn begin_release(&mut self, id: &str) {
        let Some(lease) = self.leases.get_mut(id).filter(|lease| !lease.releasing) else {
            return;
        };
        lease.releasing = true;
        if let Some(session_id) = lease.session.clone()
            && self
                .sessions
                .get(&session_id)
                .is_some_and(|session| session.prompting)
        {
            self.cancel_session(&session_id);
        }
        self.finish_release(id);
    }

    fn finish_release(&mut self, id: &str) {
        // ACP 操作和反向权限回调全部收尾后，才释放聊天锁并减少代际租约计数。
        let finished = self.leases.get(id).is_some_and(|lease| {
            lease.releasing && lease.operations == 0 && lease.permissions == 0
        });
        if !finished {
            return;
        }
        let lease = self.leases.remove(id).unwrap();
        if let Some(session) = lease
            .session
            .as_ref()
            .and_then(|id| self.sessions.get_mut(id))
            && session.lease.as_deref() == Some(id)
        {
            session.lease = None;
        }
    }

    fn worker_frame(&mut self, key: SlotKey, frame: Value) {
        let Some(slot) = self.slot(key) else {
            return;
        };
        let params = &frame["params"];
        let id = RpcId::from_value(&frame["id"]);
        let method = frame["method"].as_str().unwrap_or("");
        if method == "$/cancel_request" && id.is_none() {
            if let Some(external) =
                RpcId::from_value(&params["requestId"]).and_then(|id| slot.permissions.get(&id))
            {
                self.send(
                    json!({"jsonrpc": "2.0", "method": method, "params": {"requestId": external}}),
                );
            }
            return;
        }
        let session_id = params["sessionId"]
            .as_str()
            .and_then(|native| slot.sessions.get(native))
            .cloned();
        if method == "session/update" && id.is_none() {
            if let Some(id) = session_id.filter(|id| self.sessions[id].lease.is_some()) {
                self.sessions
                    .get_mut(&id)
                    .unwrap()
                    .observe_model(&params["update"]);
                let mut params = params.clone();
                params["sessionId"] = json!(id);
                self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
            }
            return;
        }
        let Some(id) = id else {
            return;
        };
        let Some(backend) = self.available_backend(key) else {
            return;
        };
        if method != "session/request_permission" {
            backend.respond(
                id,
                json!({"error": {"code": -32601, "message": "Client ACP method is unavailable"}}),
            );
            return;
        }
        let duplicate = slot.permissions.contains_key(&id);
        let active = session_id
            .as_ref()
            .and_then(|id| self.sessions.get(id))
            .filter(|session| session.prompting && !self.closed)
            .and_then(|session| session.lease.as_ref())
            .and_then(|id| self.leases.get_mut(id))
            .filter(|lease| !lease.releasing);
        let Some(lease) = active else {
            backend.respond(id, cancelled_permission());
            return;
        };
        if duplicate {
            return;
        }
        lease.permissions += 1;
        let lease = lease.id.clone();
        let session_id = session_id.unwrap();
        // 反向请求用新的 ID，回复和取消再通过映射转回发起请求的后端。
        let external = format!("aas-permission:{}", Uuid::new_v4());
        self.permissions.insert(
            external.clone(),
            Permission {
                native: id.clone(),
                slot: key,
                session: session_id.clone(),
                lease,
            },
        );
        self.slot_mut(key)
            .unwrap()
            .permissions
            .insert(id, external.clone());
        let mut params = params.clone();
        params["sessionId"] = json!(session_id);
        self.send(json!({"jsonrpc": "2.0", "id": external, "method": method, "params": params}));
    }

    fn answer_permission(&mut self, id: &str, frame: &Value) {
        let Some(permission) = self.permissions.remove(id) else {
            return;
        };
        if let Some(slot) = self.slot_mut(permission.slot) {
            slot.permissions.remove(&permission.native);
        }
        self.leases.get_mut(&permission.lease).unwrap().permissions -= 1;
        if let Some(backend) = self.available_backend(permission.slot) {
            let answer = if frame["result"].is_object() {
                json!({"result": frame["result"]})
            } else if frame["error"].is_object() {
                json!({"error": frame["error"]})
            } else {
                cancelled_permission()
            };
            backend.respond(permission.native, answer);
        }
        self.finish_release(&permission.lease);
    }

    fn begin_close(&mut self) {
        self.closed = true;
        for signal in self.incoming.values() {
            signal.cancel();
        }
        for lease in self.leases.keys().cloned().collect::<Vec<_>>() {
            self.begin_release(&lease);
        }
        for permission in self.permissions.keys().cloned().collect::<Vec<_>>() {
            self.answer_permission(&permission, &cancelled_permission());
        }
    }

    fn close_idle_backends(&mut self) {
        let idle = self
            .backends
            .values()
            .filter(|slot| {
                !self.leases.values().any(|lease| {
                    lease
                        .generation
                        .as_ref()
                        .is_some_and(|route| route.id == slot.key.generation)
                })
            })
            .map(|slot| slot.key)
            .collect::<Vec<_>>();
        for key in idle {
            self.end_slot(key, cancelled);
        }
    }

    fn complete(&mut self, request: RpcId, result: Result<Value, RpcFault>) {
        self.incoming.remove(&request);
        let frame = match result {
            Ok(value) => json!({"jsonrpc": "2.0", "id": request, "result": value}),
            Err(fault) => fault.frame(Some(request)),
        };
        self.send(frame);
    }

    fn send(&self, frame: Value) {
        if !self.shutdown.is_cancelled() && (self.emit)(frame).is_err() {
            self.shutdown.cancel();
        }
    }
}

fn submission_unknown() -> RpcFault {
    RpcFault::new(
        -32041,
        "Account worker disconnected after prompt submission",
        Some(json!({"kind": "submission_unknown"})),
    )
}

#[cfg(test)]
mod tests;
