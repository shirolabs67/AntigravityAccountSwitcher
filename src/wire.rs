use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

pub const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES: usize = 2 * MAX_FRAME;
const MAX_PENDING: usize = 512;
const MAX_SAFE_ID: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerError(String);

impl PeerError {
    pub fn new(category: impl Into<String>) -> Self {
        Self(category.into())
    }

    pub fn category(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PeerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.category())
    }
}

impl std::error::Error for PeerError {}

fn valid_category(category: &str) -> bool {
    let mut bytes = category.bytes();
    category.len() <= 48
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn invalid_frame() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid JSON frame")
}

async fn read_sized_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> io::Result<Option<(Value, usize)>> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(invalid_frame())
            };
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(chunk.len());
        if bytes.len() + length > MAX_FRAME {
            return Err(invalid_frame());
        }
        bytes.extend_from_slice(&chunk[..length]);
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            let payload = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
            let value: Value = serde_json::from_slice(payload).map_err(|_| invalid_frame())?;
            return if value.is_object() {
                Ok(Some((value, bytes.len() + 1)))
            } else {
                Err(invalid_frame())
            };
        }
    }
}

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<Value>> {
    Ok(read_sized_frame(reader).await?.map(|(value, _)| value))
}

pub(crate) fn encode_frame(frame: &Value) -> io::Result<Vec<u8>> {
    if !frame.is_object() {
        return Err(invalid_frame());
    }
    let mut bytes = serde_json::to_vec(frame).map_err(|_| invalid_frame())?;
    if bytes.len() > MAX_FRAME {
        return Err(invalid_frame());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Value) -> io::Result<()> {
    writer.write_all(&encode_frame(frame)?).await?;
    writer.flush().await
}

type Reply = Result<Value, PeerError>;

struct Packet {
    bytes: Vec<u8>,
    _budget: OwnedSemaphorePermit,
}

struct State {
    outgoing: mpsc::Sender<Packet>,
    outgoing_budget: Arc<Semaphore>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    closed: CancellationToken,
}

#[derive(Clone)]
pub struct Peer(Arc<State>);

pub struct Incoming {
    pub method: String,
    pub params: Value,
    id: Option<u64>,
    _budget: OwnedSemaphorePermit,
    _active: OwnedSemaphorePermit,
}

impl Incoming {
    pub fn reply(self, peer: &Peer, result: Reply) {
        if let Some(id) = self.id {
            let frame = match result {
                Ok(value) => json!({ "id": id, "result": value }),
                Err(error) => {
                    let category = error.category();
                    let category = if valid_category(category) {
                        category
                    } else {
                        "operation_failed"
                    };
                    json!({ "id": id, "error": category })
                }
            };
            let _ = peer.send(&frame);
        } else if result.is_err() {
            peer.close();
        }
    }
}

struct Pending<'a>(&'a Peer, u64);

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.0.pending.lock().unwrap().remove(&self.1);
    }
}

impl Peer {
    pub fn start<S>(stream: S) -> (Self, mpsc::Receiver<Incoming>)
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (outgoing, mut packets) = mpsc::channel::<Packet>(MAX_PENDING);
        let (incoming, requests) = mpsc::channel(MAX_PENDING);
        let peer = Self(Arc::new(State {
            outgoing,
            outgoing_budget: Arc::new(Semaphore::new(MAX_BUFFERED_BYTES)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: CancellationToken::new(),
        }));
        let link = peer.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(stream);
            let write = async {
                while let Some(packet) = packets.recv().await {
                    writer.write_all(&packet.bytes).await?;
                    writer.flush().await?;
                }
                Ok::<(), io::Error>(())
            };
            tokio::select! {
                _ = link.closed() => {}
                _ = link.read(BufReader::new(reader), incoming) => {}
                _ = write => {}
            }
            link.close();
        });
        (peer, requests)
    }

    async fn read<R: AsyncBufRead + Unpin>(
        &self,
        mut reader: R,
        incoming: mpsc::Sender<Incoming>,
    ) -> io::Result<()> {
        let budget = Arc::new(Semaphore::new(MAX_BUFFERED_BYTES));
        let active = Arc::new(Semaphore::new(MAX_PENDING));
        while let Some((mut frame, size)) = read_sized_frame(&mut reader).await? {
            if let Some(method) = frame["method"].as_str() {
                let method = method.to_owned();
                let id = frame
                    .get("id")
                    .map(|value| {
                        rpc_id(value)
                            .filter(|id| *id >= 1)
                            .ok_or_else(invalid_frame)
                    })
                    .transpose()?;
                let params = frame["params"].take();
                if !params.is_object() {
                    return Err(invalid_frame());
                }
                let message = Incoming {
                    method,
                    params,
                    id,
                    _budget: budget
                        .clone()
                        .try_acquire_many_owned(size as u32)
                        .map_err(|_| invalid_frame())?,
                    _active: active
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| invalid_frame())?,
                };
                incoming.try_send(message).map_err(|_| invalid_frame())?;
                continue;
            }
            let id = rpc_id(&frame["id"]).ok_or_else(invalid_frame)?;
            let Some(pending) = self.0.pending.lock().unwrap().remove(&id) else {
                continue; // A request may have timed out.
            };
            let result = match frame["error"]
                .as_str()
                .filter(|category| valid_category(category))
            {
                Some(category) => Err(PeerError::new(category)),
                None if frame.get("result").is_some() => Ok(frame["result"].take()),
                None => {
                    let _ = pending.send(Err(PeerError::new("invalid_response")));
                    return Err(invalid_frame());
                }
            };
            let _ = pending.send(result);
        }
        Ok(())
    }

    fn send(&self, frame: &Value) -> Result<(), PeerError> {
        if self.0.closed.is_cancelled() {
            return Err(PeerError::new("disconnected"));
        }
        let packet = encode_frame(frame).ok().and_then(|bytes| {
            let budget = self
                .0
                .outgoing_budget
                .clone()
                .try_acquire_many_owned(bytes.len() as u32)
                .ok()?;
            Some(Packet {
                bytes,
                _budget: budget,
            })
        });
        if packet.is_some_and(|packet| self.0.outgoing.try_send(packet).is_ok()) {
            Ok(())
        } else {
            self.close();
            Err(PeerError::new("disconnected"))
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), PeerError> {
        self.send(&json!({ "method": method, "params": params }))
    }

    pub async fn request(&self, method: &str, params: Value, deadline: Duration) -> Reply {
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut pending = self.0.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                return Err(PeerError::new("too_many_requests"));
            }
            let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
            if id > MAX_SAFE_ID {
                return Err(PeerError::new("too_many_requests"));
            }
            pending.insert(id, sender);
            id
        };
        let _guard = Pending(self, id);
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        tokio::select! {
            biased;
            reply = timeout(deadline, receiver) => match reply {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(PeerError::new("disconnected")),
                Err(_) => Err(PeerError::new("timeout")),
            },
            _ = self.closed() => Err(PeerError::new("disconnected")),
        }
    }

    pub fn close(&self) {
        self.0.closed.cancel();
    }

    pub async fn closed(&self) {
        self.0.closed.cancelled().await;
    }
}

fn rpc_id(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number >= 0.0 && number <= MAX_SAFE_ID as f64 && number.fract() == 0.0)
        .then_some(number as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, duplex};

    #[tokio::test]
    async fn framing_requires_bounded_utf8_objects() {
        let mut input = BufReader::with_capacity(3, &b"{\"id\":1}\r\n{\"id\":2}\n"[..]);
        assert_eq!(
            read_frame(&mut input).await.unwrap(),
            Some(json!({ "id": 1 }))
        );
        assert_eq!(
            read_frame(&mut input).await.unwrap(),
            Some(json!({ "id": 2 }))
        );
        assert!(read_frame(&mut input).await.unwrap().is_none());

        for input in [b"[]\n".as_slice(), b"{\"text\":\"\xff\"}\n", b"{}", b"\n"] {
            assert_eq!(
                read_frame(&mut &input[..]).await.unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
        let oversized = tokio::io::repeat(b' ').take((MAX_FRAME + 1) as u64);
        assert_eq!(
            read_frame(&mut BufReader::new(oversized))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn cancelling_an_outgoing_request_releases_its_slot() {
        let (left, right) = duplex(4096);
        let (peer, _) = Peer::start(left);
        let (_other, mut incoming) = Peer::start(right);
        let pending = {
            let peer = peer.clone();
            tokio::spawn(async move {
                peer.request("probe", json!({}), Duration::from_secs(60))
                    .await
            })
        };
        let request = incoming.recv().await.unwrap();
        assert_eq!(request.method, "probe");
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert!(peer.0.pending.lock().unwrap().is_empty());
        peer.close();
    }
}
