use std::collections::BTreeMap;
use std::future::{Future, pending};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::wire::PeerError;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_LATE_REPLIES: usize = 64;

pub type FrameListener = Box<dyn Fn(Value) + Send + Sync>;
pub type CloseListener = Box<dyn FnOnce() + Send>;
pub type LateResult = Box<dyn FnOnce(Value) + Send>;

pub trait WorkerStream: Send + Sync {
    fn send(&self, frame: Value) -> Result<(), PeerError>;
    fn on_frame(&self, listener: FrameListener);
    fn on_close(&self, listener: CloseListener);
    fn close(&self);
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum RpcId {
    String(String),
    Number(i64),
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64).then_some(number as i64)
}

impl RpcId {
    pub fn from_value(value: &Value) -> Option<Self> {
        if let Some(id) = value.as_str() {
            return Some(Self::String(id.to_owned()));
        }
        safe_integer(value).map(Self::Number)
    }
}

#[derive(Debug)]
pub struct RpcFault {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcFault {
    pub fn new(code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data,
        }
    }

    pub fn frame(self, id: Option<RpcId>) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = self.data {
            error["data"] = data;
        }
        json!({ "jsonrpc": "2.0", "id": id, "error": error })
    }
}

#[derive(Debug)]
pub enum BackendError {
    Fault(RpcFault),
    Disconnected,
    Timeout,
}

type Reply = Result<Value, BackendError>;
type Response = Pin<Box<dyn Future<Output = Reply> + Send>>;

struct State {
    sequence: u64,
    on_exit: Option<CloseListener>,
    pending: BTreeMap<u64, oneshot::Sender<Reply>>,
    late_results: BTreeMap<u64, LateResult>,
}

/// One native ACP endpoint with independent request IDs for each direction.
pub struct AcpBackend {
    stream: Arc<dyn WorkerStream>,
    state: Mutex<State>,
}

impl AcpBackend {
    pub fn new(
        stream: Arc<dyn WorkerStream>,
        on_frame: impl Fn(Value) + Send + Sync + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Arc<Self> {
        let backend = Arc::new(Self {
            stream: stream.clone(),
            state: Mutex::new(State {
                sequence: 0,
                on_exit: Some(Box::new(on_exit)),
                pending: BTreeMap::new(),
                late_results: BTreeMap::new(),
            }),
        });
        let weak = Arc::downgrade(&backend);
        stream.on_frame(Box::new(move |frame| {
            let Some(backend) = weak.upgrade() else {
                return;
            };
            if frame["jsonrpc"] != "2.0" || backend.closed() {
                return;
            }
            if frame["method"].is_string() {
                on_frame(frame);
            } else {
                backend.receive_reply(frame);
            }
        }));
        let weak = Arc::downgrade(&backend);
        stream.on_close(Box::new(move || {
            if let Some(backend) = weak.upgrade() {
                backend.end();
            }
        }));
        backend
    }

    fn receive_reply(&self, mut frame: Value) {
        let Some(id) = safe_integer(&frame["id"]).and_then(|id| u64::try_from(id).ok()) else {
            return;
        };
        let (waiting, late) = {
            let mut state = self.state.lock().unwrap();
            (state.pending.remove(&id), state.late_results.remove(&id))
        };
        if let Some(waiting) = waiting {
            let error = &frame["error"];
            let reply = if let (Some(code), Some(message)) =
                (safe_integer(&error["code"]), error["message"].as_str())
            {
                Err(BackendError::Fault(RpcFault::new(
                    code,
                    message,
                    error.get("data").cloned(),
                )))
            } else if let Some(result) = frame.get_mut("result") {
                Ok(result.take())
            } else {
                Err(BackendError::Fault(RpcFault::new(
                    -32603,
                    "Invalid ACP worker response",
                    None,
                )))
            };
            let _ = waiting.send(reply);
        } else if frame.get("error").is_none()
            && let (Some(late), Some(result)) = (late, frame.get_mut("result"))
        {
            late(result.take());
        }
    }

    pub fn closed(&self) -> bool {
        self.state.lock().unwrap().on_exit.is_none()
    }

    /// Queue the request before returning the future so subsequent notifications stay ordered.
    pub fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        signal: Option<CancellationToken>,
        timeout: Option<Duration>,
        on_late_result: Option<LateResult>,
    ) -> Response {
        let (sender, mut receiver) = oneshot::channel();
        let id = {
            let mut state = self.state.lock().unwrap();
            if state.on_exit.is_none() {
                return Box::pin(async { Err(BackendError::Disconnected) });
            }
            if signal.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Box::pin(async {
                    Err(BackendError::Fault(RpcFault::new(
                        -32800,
                        "Request cancelled",
                        None,
                    )))
                });
            }
            state.sequence += 1;
            let id = state.sequence;
            state.pending.insert(id, sender);
            id
        };
        let mut request = PendingRequest {
            backend: self.clone(),
            id,
            on_late_result,
            cancel_sent: false,
        };
        let deadline = timeout.map(|duration| Instant::now() + duration);
        self.send(json!({ "jsonrpc": "2.0", "method": method, "id": id, "params": params }));
        Box::pin(async move {
            let wait_deadline = async {
                if let Some(deadline) = deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    pending::<()>().await;
                }
            };
            let wait_cancellation = async {
                if let Some(signal) = signal {
                    signal.cancelled().await;
                } else {
                    pending::<()>().await;
                }
            };
            tokio::pin!(wait_deadline, wait_cancellation);
            loop {
                tokio::select! {
                    biased;
                    result = &mut receiver => return result.unwrap_or(Err(BackendError::Disconnected)),
                    () = &mut wait_cancellation, if !request.cancel_sent => request.cancel(),
                    () = &mut wait_deadline => {
                        if request.abandon() {
                            return Err(BackendError::Timeout);
                        }
                        return receiver.await.unwrap_or(Err(BackendError::Disconnected));
                    }
                }
            }
        })
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn respond(&self, id: RpcId, mut frame: Value) {
        frame["jsonrpc"] = json!("2.0");
        frame["id"] = json!(id);
        self.send(frame);
    }

    pub fn close(&self) {
        if self.end() {
            self.stream.close();
        }
    }

    fn send(&self, frame: Value) {
        if !self.closed() && self.stream.send(frame).is_err() {
            self.close();
        }
    }

    fn end(&self) -> bool {
        let (on_exit, pending, late_results) = {
            let mut state = self.state.lock().unwrap();
            let Some(on_exit) = state.on_exit.take() else {
                return false;
            };
            (
                on_exit,
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.late_results),
            )
        };
        on_exit();
        drop((pending, late_results));
        true
    }
}

impl Drop for AcpBackend {
    fn drop(&mut self) {
        self.close();
    }
}

struct PendingRequest {
    backend: Arc<AcpBackend>,
    id: u64,
    on_late_result: Option<LateResult>,
    cancel_sent: bool,
}

impl PendingRequest {
    fn cancel(&mut self) {
        if !self.cancel_sent {
            self.cancel_sent = true;
            self.backend
                .notify("$/cancel_request", json!({ "requestId": self.id }));
        }
    }

    fn abandon(&mut self) -> bool {
        let displaced = {
            let mut state = self.backend.state.lock().unwrap();
            if state.pending.remove(&self.id).is_none() {
                return false;
            }
            // 取消后仍可能收到成功响应，保留回调以清理后端已创建的资源。
            let mut displaced = None;
            if let Some(on_late_result) = self.on_late_result.take() {
                if state.late_results.len() >= MAX_LATE_REPLIES {
                    displaced = state.late_results.pop_first();
                }
                state.late_results.insert(self.id, on_late_result);
            }
            displaced
        };
        drop(displaced);
        self.cancel();
        true
    }
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.abandon();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    type Listener = Arc<dyn Fn(Value) + Send + Sync>;

    struct FakeStream {
        outgoing: mpsc::UnboundedSender<Value>,
        on_frame: Mutex<Option<Listener>>,
        on_close: Mutex<Option<CloseListener>>,
    }

    impl FakeStream {
        fn frame(&self, frame: Value) {
            let listener = self.on_frame.lock().unwrap().clone().unwrap();
            listener(frame);
        }
    }

    impl WorkerStream for FakeStream {
        fn send(&self, frame: Value) -> Result<(), PeerError> {
            self.outgoing
                .send(frame)
                .map_err(|_| PeerError::new("disconnected"))
        }

        fn on_frame(&self, listener: FrameListener) {
            *self.on_frame.lock().unwrap() = Some(listener.into());
        }

        fn on_close(&self, listener: CloseListener) {
            *self.on_close.lock().unwrap() = Some(listener);
        }

        fn close(&self) {
            let listener = self.on_close.lock().unwrap().take();
            if let Some(listener) = listener {
                listener();
            }
        }
    }

    fn stream() -> (Arc<FakeStream>, mpsc::UnboundedReceiver<Value>) {
        let (outgoing, receiver) = mpsc::unbounded_channel();
        (
            Arc::new(FakeStream {
                outgoing,
                on_frame: Mutex::default(),
                on_close: Mutex::default(),
            }),
            receiver,
        )
    }

    #[tokio::test]
    async fn cancellation_uses_the_native_request_id_and_waits_for_completion() {
        let (stream, mut outgoing) = stream();
        let backend = AcpBackend::new(stream.clone(), |_| {}, || {});
        let signal = CancellationToken::new();
        let result = backend.request(
            "session/prompt",
            json!({}),
            Some(signal.clone()),
            None,
            None,
        );
        let request = outgoing.try_recv().unwrap();
        assert_eq!(request["method"], "session/prompt");
        let waiter = tokio::spawn(result);
        signal.cancel();
        let cancel = timeout(Duration::from_secs(2), outgoing.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancel["method"], "$/cancel_request");
        assert_eq!(cancel["params"]["requestId"], request["id"]);
        assert!(!waiter.is_finished());
        stream.frame(json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "stopReason": "cancelled" } }));
        assert_eq!(waiter.await.unwrap().unwrap()["stopReason"], "cancelled");
    }

    #[tokio::test]
    async fn timed_out_session_creation_delivers_a_late_result_for_cleanup() {
        let (stream, mut outgoing) = stream();
        let backend = AcpBackend::new(stream.clone(), |_| {}, || {});
        let (late, received) = oneshot::channel();
        let pending = backend.request(
            "session/new",
            json!({}),
            None,
            Some(Duration::ZERO),
            Some(Box::new(move |result| {
                late.send(result).unwrap();
            })),
        );
        let request = outgoing.try_recv().unwrap();
        assert!(matches!(pending.await, Err(BackendError::Timeout)));
        let cancel = outgoing.try_recv().unwrap();
        assert_eq!(cancel["params"]["requestId"], request["id"]);
        stream.frame(json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "sessionId": "late-session" } }));
        assert_eq!(received.await.unwrap()["sessionId"], "late-session");
    }

    #[tokio::test]
    async fn stream_disconnect_finishes_pending_requests_and_rejects_new_ones() {
        let (stream, _outgoing) = stream();
        let (exited, exit) = oneshot::channel();
        let backend = AcpBackend::new(stream.clone(), |_| {}, || exited.send(()).unwrap());
        let pending = backend.request("session/prompt", json!({}), None, None, None);
        stream.close();
        assert!(backend.closed());
        exit.await.unwrap();
        assert!(matches!(pending.await, Err(BackendError::Disconnected)));
        assert!(matches!(
            backend
                .request("session/new", json!({}), None, None, None)
                .await,
            Err(BackendError::Disconnected)
        ));
    }
}
