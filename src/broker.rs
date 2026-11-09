use std::collections::{HashMap, HashSet, VecDeque};
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use socket2::{SockRef, TcpKeepalive};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::acp_backend::{CloseListener, FrameListener, WorkerStream};
use crate::config::{BrokerConfig, ClientConfig, Fingerprint, Identity, fingerprint};
use crate::router::{Router, RouterConnection, WorkerDirectory};
use crate::wire::{Incoming, Peer, PeerError};
use crate::worker::Quota;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
pub const READY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STREAMS: usize = 100;
const EARLY_FRAMES: usize = 4;

fn keepalive(socket: &TcpStream) {
    let settings = TcpKeepalive::new().with_time(Duration::from_secs(15));
    let _ = SockRef::from(socket).set_tcp_keepalive(&settings);
}

pub async fn connect(config: ClientConfig) -> Result<(Peer, mpsc::Receiver<Incoming>), PeerError> {
    timeout(HANDSHAKE_TIMEOUT, async {
        let connect_error = |_| PeerError::new("broker_connection_failed");
        let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(connect_error)?;
        keepalive(&socket);
        let stream = TlsConnector::from(config.tls)
            .connect(config.server_name, socket)
            .await
            .map_err(connect_error)?;
        let pin = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|chain| chain.first())
            .map(fingerprint);
        if pin != Some(config.server_pin) {
            return Err(PeerError::new("invalid_server_fingerprint"));
        }
        Ok(Peer::start(stream))
    })
    .await
    .map_err(|_| PeerError::new("broker_timeout"))?
}

#[derive(Default)]
struct StreamState {
    ended: bool,
    draining: bool,
    frames: VecDeque<Value>,
    frame_listener: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    close_listener: Option<CloseListener>,
}

struct RemoteStream {
    worker: Weak<AttachedWorker>,
    id: String,
    state: Mutex<StreamState>,
}

impl RemoteStream {
    fn frame(&self, frame: Value) {
        {
            let mut state = self.state.lock().unwrap();
            if state.ended {
                return;
            }
            if state.frames.len() >= EARLY_FRAMES {
                drop(state);
                self.close();
                return;
            }
            state.frames.push_back(frame);
        }
        self.drain();
    }

    fn drain(&self) {
        {
            let mut state = self.state.lock().unwrap();
            if state.draining || state.ended || state.frame_listener.is_none() {
                return;
            }
            state.draining = true;
        }
        loop {
            let (listener, frame) = {
                let mut state = self.state.lock().unwrap();
                let (Some(listener), Some(frame)) =
                    (state.frame_listener.clone(), state.frames.pop_front())
                else {
                    state.draining = false;
                    return;
                };
                (listener, frame)
            };
            // 监听器可能在回调中关闭这条流，因此在锁外调用。
            listener(frame);
        }
    }

    fn disconnect(&self, notify: bool) {
        let listener = {
            let mut state = self.state.lock().unwrap();
            if state.ended {
                return;
            }
            state.ended = true;
            state.frames.clear();
            state.frame_listener = None;
            state.close_listener.take()
        };
        if let Some(worker) = self.worker.upgrade() {
            worker.streams.lock().unwrap().remove(&self.id);
            if notify {
                let _ = worker
                    .peer
                    .notify("worker/close", json!({ "streamId": self.id }));
            }
        }
        if let Some(listener) = listener {
            listener();
        }
    }
}

impl WorkerStream for RemoteStream {
    fn send(&self, frame: Value) -> Result<(), PeerError> {
        if self.state.lock().unwrap().ended {
            return Err(PeerError::new("stream_disconnected"));
        }
        let worker = self
            .worker
            .upgrade()
            .ok_or_else(|| PeerError::new("stream_disconnected"))?;
        worker.peer.notify(
            "worker/send",
            json!({ "streamId": self.id, "frame": frame }),
        )
    }

    fn on_frame(&self, listener: FrameListener) {
        let mut state = self.state.lock().unwrap();
        if !state.ended {
            state.frame_listener = Some(Arc::from(listener));
        }
        drop(state);
        self.drain();
    }

    fn on_close(&self, listener: CloseListener) {
        let mut state = self.state.lock().unwrap();
        if state.ended {
            drop(state);
            listener();
        } else {
            state.close_listener = Some(listener);
        }
    }

    fn close(&self) {
        self.disconnect(true);
    }
}

struct AttachedWorker {
    peer: Peer,
    streams: Mutex<HashMap<String, Arc<RemoteStream>>>,
}

#[derive(Default)]
struct Workers(Mutex<HashMap<String, Arc<AttachedWorker>>>);

impl Workers {
    fn get(&self, id: &str) -> Result<Arc<AttachedWorker>, PeerError> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| PeerError::new("worker_offline"))
    }

    fn attach(&self, id: &str, peer: Peer) -> Result<Arc<AttachedWorker>, PeerError> {
        let mut attached = self.0.lock().unwrap();
        if attached.contains_key(id) {
            return Err(PeerError::new("duplicate_worker"));
        }
        let worker = Arc::new(AttachedWorker {
            peer,
            streams: Mutex::new(HashMap::new()),
        });
        attached.insert(id.to_owned(), worker.clone());
        Ok(worker)
    }

    fn detach(&self, id: &str, worker: &AttachedWorker) {
        self.0.lock().unwrap().remove(id);
        let streams = std::mem::take(&mut *worker.streams.lock().unwrap());
        for stream in streams.into_values() {
            stream.disconnect(false);
        }
    }
}

// Own the provisional stream until its open request succeeds. Timeout and
// cancellation both close it, including when the worker processed a late open.
struct Opening(Option<Arc<RemoteStream>>);

impl Drop for Opening {
    fn drop(&mut self) {
        if let Some(stream) = self.0.take() {
            stream.close();
        }
    }
}

#[async_trait]
impl WorkerDirectory for Workers {
    async fn probe(&self, account_id: &str, group_id: &str) -> Result<Quota, PeerError> {
        let worker = self.get(account_id)?;
        let result = worker
            .peer
            .request(
                "worker/probe",
                json!({ "groupId": group_id }),
                Duration::from_secs(32),
            )
            .await?;
        let (Some(weekly), Some(five_hour)) =
            (result["weekly"].as_f64(), result["fiveHour"].as_f64())
        else {
            return Err(PeerError::new("invalid_quota"));
        };
        Ok(Quota { weekly, five_hour })
    }

    async fn open(&self, account_id: &str) -> Result<Arc<dyn WorkerStream>, PeerError> {
        let worker = self.get(account_id)?;
        let id = Uuid::new_v4().to_string();
        // 先登记流，确保早于 worker/open 响应抵达的帧也能找到它。
        let mut opening = {
            let mut streams = worker.streams.lock().unwrap();
            if streams.len() >= MAX_STREAMS {
                return Err(PeerError::new("worker_busy"));
            }
            let stream = Arc::new(RemoteStream {
                worker: Arc::downgrade(&worker),
                id: id.clone(),
                state: Mutex::default(),
            });
            streams.insert(id.clone(), stream.clone());
            Opening(Some(stream))
        };
        worker
            .peer
            .request(
                "worker/open",
                json!({ "streamId": id }),
                Duration::from_secs(10),
            )
            .await?;
        if !worker.streams.lock().unwrap().contains_key(&id) {
            return Err(PeerError::new("stream_disconnected"));
        }
        Ok(opening.0.take().expect("provisional stream"))
    }
}

struct Broker {
    acceptor: TlsAcceptor,
    fingerprints: HashMap<Fingerprint, Identity>,
    router: Router,
    workers: Arc<Workers>,
    ingress: Mutex<HashSet<String>>,
}

impl Broker {
    async fn handle(&self, socket: TcpStream, stop: &CancellationToken) {
        let stream = tokio::select! {
            _ = stop.cancelled() => return,
            stream = timeout(HANDSHAKE_TIMEOUT, self.acceptor.accept(socket)) => match stream {
                Ok(Ok(stream)) => stream,
                _ => return,
            }
        };
        // TLS 验证证书链后，由叶证书指纹确定此连接的角色和实例或账号归属。
        let Some(identity) = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|chain| chain.first())
            .and_then(|certificate| self.fingerprints.get(&fingerprint(certificate)))
        else {
            return;
        };
        keepalive(stream.get_ref().0);
        let (peer, mut requests) = Peer::start(stream);
        let ready = async {
            while let Some(request) = requests.recv().await {
                if request.method == "broker/ready" {
                    return Some(request);
                }
                request.reply(&peer, Err(PeerError::new("unknown_operation")));
            }
            None
        };
        let ready = tokio::select! {
            _ = stop.cancelled() => None,
            _ = peer.closed() => None,
            request = timeout(READY_TIMEOUT, ready) => request.ok().flatten(),
        };
        if let Some(ready) = ready {
            match identity {
                Identity::Worker(id) => self.worker(id, &peer, &mut requests, ready, stop).await,
                Identity::Ingress(id) => self.ingress(id, &peer, &mut requests, ready, stop).await,
            }
        }
        peer.close();
    }

    async fn worker(
        &self,
        id: &str,
        peer: &Peer,
        requests: &mut mpsc::Receiver<Incoming>,
        ready: Incoming,
        stop: &CancellationToken,
    ) {
        let worker = match self.workers.attach(id, peer.clone()) {
            Ok(worker) => worker,
            Err(error) => {
                ready.reply(peer, Err(error));
                wait_for_rejected_peer(peer, stop).await;
                return;
            }
        };
        ready.reply(peer, Ok(json!(true)));
        loop {
            let request = tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = peer.closed() => break,
                request = requests.recv() => match request { Some(request) => request, None => break },
            };
            let result = match request.method.as_str() {
                "broker/ready" => Err(PeerError::new("already_ready")),
                method => handle_worker_frame(&worker, method, &request.params),
            };
            request.reply(peer, result);
        }
        self.workers.detach(id, &worker);
    }

    fn register_ingress(&self, id: &str, peer: &Peer) -> Result<RouterConnection, PeerError> {
        let mut ingress = self.ingress.lock().unwrap();
        if ingress.contains(id) {
            return Err(PeerError::new("duplicate_instance"));
        }
        let peer = peer.clone();
        let client = self.router.connect(id, move |frame| {
            peer.notify("acp/frame", json!({ "frame": frame }))
        })?;
        ingress.insert(id.to_owned());
        Ok(client)
    }

    async fn ingress(
        &self,
        id: &str,
        peer: &Peer,
        requests: &mut mpsc::Receiver<Incoming>,
        ready: Incoming,
        stop: &CancellationToken,
    ) {
        let client = match self.register_ingress(id, peer) {
            Ok(client) => client,
            Err(error) => {
                ready.reply(peer, Err(error));
                wait_for_rejected_peer(peer, stop).await;
                return;
            }
        };
        ready.reply(peer, Ok(json!(true)));
        loop {
            let mut request = tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = peer.closed() => break,
                _ = client.closed() => break,
                request = requests.recv() => match request { Some(request) => request, None => break },
            };
            let result = match request.method.as_str() {
                "broker/ready" => Err(PeerError::new("already_ready")),
                "acp/frame" if request.params["frame"].is_object() => {
                    client.receive(request.params["frame"].take())
                }
                "acp/frame" => Err(PeerError::new("invalid_frame")),
                _ => Err(PeerError::new("unknown_operation")),
            };
            request.reply(peer, result.map(|()| Value::Null));
        }
        client.close();
        self.ingress.lock().unwrap().remove(id);
    }
}

async fn wait_for_rejected_peer(peer: &Peer, stop: &CancellationToken) {
    // Let the ready error flush before tearing down the authenticated socket.
    tokio::select! {
        _ = stop.cancelled() => {},
        _ = timeout(READY_TIMEOUT, peer.closed()) => {},
    }
}

fn handle_worker_frame(
    worker: &AttachedWorker,
    method: &str,
    params: &Value,
) -> Result<Value, PeerError> {
    let id = params["streamId"]
        .as_str()
        .ok_or_else(|| PeerError::new("unknown_operation"))?;
    let stream = worker.streams.lock().unwrap().get(id).cloned();
    match method {
        "worker/frame" if params["frame"].is_object() => {
            if let Some(stream) = stream {
                stream.frame(params["frame"].clone());
            }
        }
        "worker/frame" => return Err(PeerError::new("invalid_frame")),
        "worker/closed" => {
            if let Some(stream) = stream {
                stream.disconnect(false);
            }
        }
        _ => return Err(PeerError::new("unknown_operation")),
    }
    Ok(Value::Null)
}

pub async fn serve(config: BrokerConfig, stop: CancellationToken) -> Result<(), PeerError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .map_err(|_| PeerError::new("router_listen_failed"))?;
    let workers = Arc::new(Workers::default());
    let broker = Arc::new(Broker {
        acceptor: TlsAcceptor::from(config.tls),
        fingerprints: config.fingerprints,
        router: Router::new(config.routing, workers.clone()),
        workers,
        ingress: Mutex::default(),
    });
    let capacity = Arc::new(Semaphore::new(128));
    let mut connections = JoinSet::new();
    eprintln!("Router listening on loopback.");
    let result = loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break Ok(()),
            _ = connections.join_next(), if !connections.is_empty() => {},
            result = listener.accept() => match result {
                Ok((socket, _)) => {
                    if let Ok(permit) = capacity.clone().try_acquire_owned() {
                        let broker = broker.clone();
                        let stop = stop.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            broker.handle(socket, &stop).await;
                        });
                    }
                }
                Err(_) => break Err(PeerError::new("router_listen_failed")),
            }
        }
    };
    stop.cancel();
    while connections.join_next().await.is_some() {}
    result
}
