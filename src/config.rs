use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig as TlsClientConfig, RootCertStore, ServerConfig as TlsServerConfig};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::router::RouterConfig;
use crate::wire::PeerError;

const MAX_FILE: u64 = 256 * 1024;
pub type Fingerprint = [u8; 32];

#[derive(Clone)]
pub enum Identity {
    Worker(String),
    Ingress(String),
}

pub struct BrokerConfig {
    pub port: u16,
    pub tls: Arc<TlsServerConfig>,
    pub fingerprints: HashMap<Fingerprint, Identity>,
    pub routing: RouterConfig,
}

pub struct ClientConfig {
    pub port: u16,
    pub tls: Arc<TlsClientConfig>,
    pub server_name: ServerName<'static>,
    pub server_pin: Fingerprint,
}

pub struct WorkerConfig {
    pub client: ClientConfig,
    pub run_as_user: String,
    pub agy_path: PathBuf,
    pub cwd: PathBuf,
    pub probe_timeout: Duration,
}

fn invalid(field: &str) -> PeerError {
    PeerError::new(format!("invalid_{field}"))
}

fn record<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, PeerError> {
    value.as_object().ok_or_else(|| invalid(field))
}

fn validate_text<'a>(text: &'a str, field: &str, max: usize) -> Result<&'a str, PeerError> {
    if text.trim().is_empty()
        || text.encode_utf16().count() > max
        || text.bytes().any(|byte| byte <= 0x1f)
    {
        return Err(invalid(field));
    }
    Ok(text)
}

fn string<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str, PeerError> {
    validate_text(value.as_str().ok_or_else(|| invalid(field))?, field, max)
}

fn integer(value: &Value, field: &str, min: u32, max: u32) -> Result<u32, PeerError> {
    let number = value.as_f64().ok_or_else(|| invalid(field))?;
    if number.fract() != 0.0 || number < f64::from(min) || number > f64::from(max) {
        return Err(invalid(field));
    }
    Ok(number as u32)
}

fn port(value: &Value, field: &str) -> Result<u16, PeerError> {
    Ok(integer(value, field, 1024, 65535)? as u16)
}

fn identifier(value: &str, field: &str) -> Result<String, PeerError> {
    validate_text(value, field, 64)?;
    let mut bytes = value.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid(field));
    }
    Ok(value.to_owned())
}

fn pin(value: &Value, field: &str) -> Result<Fingerprint, PeerError> {
    let text = string(value, field, 256)?.replace(':', "");
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(field));
    }
    let mut decoded = [0; 32];
    for (index, byte) in decoded.iter_mut().enumerate() {
        *byte =
            u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).map_err(|_| invalid(field))?;
    }
    Ok(decoded)
}

pub fn fingerprint(certificate: &CertificateDer<'_>) -> Fingerprint {
    Sha256::digest(certificate.as_ref()).into()
}

fn read_file(path: &Path, field: &str) -> Result<Vec<u8>, PeerError> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MAX_FILE + 1).read_to_end(&mut bytes))
        .map_err(|_| invalid(field))?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(invalid(field));
    }
    Ok(bytes)
}

fn load(path: &Path) -> Result<(Value, PathBuf), PeerError> {
    let path = std::path::absolute(path).map_err(|_| invalid("config"))?;
    let bytes = read_file(&path, "config")?;
    let raw = serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))
        .map_err(|_| invalid("config"))?;
    record(&raw, "config")?;
    Ok((
        raw,
        path.parent().ok_or_else(|| invalid("config"))?.to_owned(),
    ))
}

struct TlsFiles {
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    roots: RootCertStore,
}

fn certificates(bytes: &[u8], field: &str) -> Result<Vec<CertificateDer<'static>>, PeerError> {
    let certs = rustls_pemfile::certs(&mut BufReader::new(bytes))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid(field))?;
    if certs.is_empty() {
        return Err(invalid(field));
    }
    Ok(certs)
}

fn tls_files(tls: &Value, directory: &Path) -> Result<TlsFiles, PeerError> {
    record(tls, "tls")?;
    let pem =
        |key: &str, field: &str| read_file(&directory.join(string(&tls[key], field, 1024)?), field);
    let key = rustls_pemfile::private_key(&mut BufReader::new(pem("key", "tls_key")?.as_slice()))
        .map_err(|_| invalid("tls_key"))?
        .ok_or_else(|| invalid("tls_key"))?;
    let chain = certificates(&pem("cert", "tls_cert")?, "tls_cert")?;
    let mut roots = RootCertStore::empty();
    for certificate in certificates(&pem("ca", "tls_ca")?, "tls_ca")? {
        roots.add(certificate).map_err(|_| invalid("tls_ca"))?;
    }
    Ok(TlsFiles { chain, key, roots })
}

pub fn broker(path: &Path) -> Result<BrokerConfig, PeerError> {
    let (raw, directory) = load(path)?;
    let listen = port(&raw["port"], "port")?;
    let mut fingerprints = HashMap::new();
    let mut register = |value: &Value, identity: Identity| {
        if fingerprints
            .insert(pin(value, "fingerprint")?, identity)
            .is_some()
        {
            return Err(invalid("fingerprint"));
        }
        Ok(())
    };
    let rows = raw["accounts"]
        .as_array()
        .ok_or_else(|| invalid("accounts"))?;
    if rows.is_empty() || rows.len() > 20 {
        return Err(invalid("accounts"));
    }
    let mut accounts = Vec::new();
    for row in rows {
        record(row, "accounts")?;
        let id = identifier(string(&row["id"], "account_id", 64)?, "account_id")?;
        if accounts.contains(&id) {
            return Err(invalid("accounts"));
        }
        register(&row["fingerprint256"], Identity::Worker(id.clone()))?;
        accounts.push(id);
    }
    let mut instances = HashMap::new();
    let mut ports = HashSet::from([listen]);
    let instance_rows = record(&raw["instances"], "instances")?;
    if instance_rows.is_empty() || instance_rows.len() > 100 {
        return Err(invalid("instances"));
    }
    for (name, row) in instance_rows {
        let id = identifier(name, "instance_id")?;
        record(row, "instance")?;
        let mcp_port = port(&row["mcpPort"], "mcp_port")?;
        if !ports.insert(mcp_port) {
            return Err(invalid("mcp_port"));
        }
        register(&row["fingerprint256"], Identity::Ingress(id.clone()))?;
        instances.insert(id, mcp_port);
    }
    let mut model_groups = HashMap::new();
    let models = record(&raw["modelGroups"], "model_groups")?;
    if models.is_empty() || models.len() > 200 {
        return Err(invalid("model_groups"));
    }
    for (model, group) in models {
        model_groups.insert(
            validate_text(model, "model_id", 160)?.to_owned(),
            string(group, "model_group", 160)?.to_owned(),
        );
    }
    let threshold = match raw.get("threshold") {
        Some(value) => value
            .as_f64()
            .filter(|number| (0.0..=1.0).contains(number))
            .ok_or_else(|| invalid("threshold"))?,
        None => 0.05,
    };
    let exhausted_message = match raw.get("exhaustedMessage") {
        Some(value) => string(value, "exhausted_message", 4096)?,
        None => "余额不足",
    }
    .to_owned();
    let TlsFiles { chain, key, roots } = tls_files(&raw["tls"], &directory)?;
    let crypto = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), crypto.clone())
        .build()
        .map_err(|_| invalid("tls_ca"))?;
    let tls = TlsServerConfig::builder_with_provider(crypto)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| invalid("tls"))?
        .with_client_cert_verifier(verifier)
        .with_single_cert(chain, key)
        .map_err(|_| invalid("tls"))?;
    let routing = RouterConfig {
        accounts,
        instances,
        model_groups,
        threshold,
        exhausted_message,
    };
    Ok(BrokerConfig {
        port: listen,
        tls: Arc::new(tls),
        fingerprints,
        routing,
    })
}

fn client(raw: &Value, directory: &Path) -> Result<ClientConfig, PeerError> {
    let tls = &raw["tls"];
    record(tls, "tls")?;
    let server_name =
        ServerName::try_from(string(&tls["serverName"], "server_name", 255)?.to_owned())
            .map_err(|_| invalid("server_name"))?;
    let server_pin = pin(&tls["serverFingerprint256"], "server_fingerprint")?;
    let TlsFiles { chain, key, roots } = tls_files(tls, directory)?;
    let tls =
        TlsClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| invalid("tls"))?
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, key)
            .map_err(|_| invalid("tls"))?;
    Ok(ClientConfig {
        port: port(&raw["port"], "port")?,
        tls: Arc::new(tls),
        server_name,
        server_pin,
    })
}

pub fn ingress(path: &Path) -> Result<ClientConfig, PeerError> {
    let (raw, directory) = load(path)?;
    client(&raw, &directory)
}

pub fn worker(path: &Path) -> Result<WorkerConfig, PeerError> {
    let (raw, directory) = load(path)?;
    if raw.get("geminiDir").is_some() {
        return Err(PeerError::new("remove_gemini_dir_use_service_home"));
    }
    let probe_timeout = match raw.get("probeTimeoutMs").filter(|value| !value.is_null()) {
        Some(value) => integer(value, "probe_timeout", 100, 30_000)?,
        None => 15_000,
    };
    Ok(WorkerConfig {
        client: client(&raw, &directory)?,
        run_as_user: string(&raw["runAsUser"], "run_as_user", 128)?.to_owned(),
        agy_path: directory.join(string(&raw["agyPath"], "agyPath", 1024)?),
        cwd: directory.join(string(&raw["cwd"], "cwd", 1024)?),
        probe_timeout: Duration::from_millis(u64::from(probe_timeout)),
    })
}
