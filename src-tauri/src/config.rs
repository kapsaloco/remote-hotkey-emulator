use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use regex::Regex;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const INVALID: &str =
    "Invalid configuration. Check the documented schema; values are omitted to protect secrets.";
pub const ACTIONS: [&str; 6] = [
    "saveState",
    "loadState",
    "nextSlot",
    "previousSlot",
    "pauseResume",
    "fastForward",
];
pub const LABELS: [&str; 6] = [
    "Save state",
    "Load state",
    "Next slot",
    "Previous slot",
    "Pause / Resume",
    "Fast-forward",
];

pub fn has_control(value: &str) -> bool {
    static CONTROL: OnceLock<Regex> = OnceLock::new();
    CONTROL
        .get_or_init(|| Regex::new(r"\p{C}").expect("constant Unicode pattern"))
        .is_match(value)
}

pub fn valid_id(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Chord {
    pub key: String,
    pub modifiers: Vec<String>,
}
impl Chord {
    pub fn display(&self) -> String {
        self.modifiers
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(self.key.as_str()))
            .collect::<Vec<_>>()
            .join("+")
    }
    fn validate(&mut self) -> Result<(), String> {
        let key = self.key.as_str();
        let valid_key = matches!(key, "Space" | "Tab")
            || (key.len() == 1
                && key
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
            || (1..=12).any(|i| key == format!("F{i}"));
        let order = ["Ctrl", "Alt", "Shift"];
        let unique: HashSet<_> = self.modifiers.iter().collect();
        if !valid_key
            || self.modifiers.len() > 3
            || unique.len() != self.modifiers.len()
            || self.modifiers.iter().any(|m| !order.contains(&m.as_str()))
            || (matches!(key, "F4" | "Tab") && self.modifiers.iter().any(|m| m == "Alt"))
        {
            return Err(INVALID.into());
        }
        self.modifiers
            .sort_by_key(|m| order.iter().position(|item| *item == m).unwrap_or(3));
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub process_names: Vec<String>,
    pub actions: BTreeMap<String, Chord>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profiles {
    pub schema_version: u32,
    pub default_profile_id: String,
    pub profiles: Vec<Profile>,
}
impl Profiles {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.schema_version != 1 || !(1..=20).contains(&self.profiles.len()) {
            return Err(INVALID.into());
        }
        let mut ids = HashSet::new();
        for profile in &mut self.profiles {
            if !valid_id(&profile.id)
                || !ids.insert(profile.id.clone())
                || !(1..=64).contains(&profile.label.chars().count())
                || has_control(&profile.label)
                || !(1..=5).contains(&profile.process_names.len())
            {
                return Err(INVALID.into());
            }
            let mut processes = HashSet::new();
            for name in &profile.process_names {
                if name.len() > 128
                    || !name.ends_with(".exe")
                    || name.len() < 5
                    || !name.as_bytes()[0].is_ascii_alphanumeric()
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                    || !processes.insert(name.to_ascii_lowercase())
                {
                    return Err(INVALID.into());
                }
            }
            if ACTIONS[..2]
                .iter()
                .any(|id| !profile.actions.contains_key(*id))
                || profile
                    .actions
                    .keys()
                    .any(|id| !ACTIONS.contains(&id.as_str()))
            {
                return Err(INVALID.into());
            }
            let mut chords = HashSet::new();
            for chord in profile.actions.values_mut() {
                chord.validate()?;
                if !chords.insert(chord.display()) {
                    return Err(INVALID.into());
                }
            }
        }
        if !ids.contains(&self.default_profile_id) {
            return Err(INVALID.into());
        }
        Ok(self)
    }
    pub fn public_view(&self) -> serde_json::Value {
        serde_json::json!({"defaultProfileId": self.default_profile_id, "profiles": self.profiles.iter().map(|profile| {
            let actions: BTreeMap<_, _> = ACTIONS.iter().zip(LABELS).filter_map(|(id, label)| {
                profile.actions.get(*id).map(|chord| (*id, serde_json::json!({"label":label,"shortcut":chord.display()})))
            }).collect();
            serde_json::json!({"id":profile.id,"label":profile.label,"actions":actions})
        }).collect::<Vec<_>>()})
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyPassword {
    salt: String,
    hash: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<LegacyPassword>,
}
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn valid_token(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
pub fn private_address(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}
pub fn addresses() -> Result<Vec<String>, String> {
    let mut result = vec!["127.0.0.1".to_string()];
    for interface in if_addrs::get_if_addrs().map_err(|_| "Could not list network interfaces.")? {
        if let std::net::IpAddr::V4(ip) = interface.ip() {
            if private_address(ip) {
                result.push(ip.to_string());
            }
        }
    }
    result.sort();
    result.dedup();
    Ok(result)
}
pub fn validate_host(host: &str, assigned: &[String]) -> Result<(), String> {
    let ip: Ipv4Addr = host.parse().map_err(|_| INVALID)?;
    if ip.to_string() != host
        || !(host == "127.0.0.1" || (private_address(ip) && assigned.iter().any(|a| a == host)))
    {
        return Err(INVALID.into());
    }
    Ok(())
}
impl ServerConfig {
    pub fn validate(&self, assigned: &[String]) -> Result<(), String> {
        validate_host(&self.host, assigned)?;
        if self.port == 0 || !valid_token(&self.token) {
            return Err(INVALID.into());
        }
        if let Some(password) = &self.password {
            let hex = |s: &str, size| {
                s.len() == size
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            };
            if !hex(&password.salt, 32) || !hex(&password.hash, 64) {
                return Err(INVALID.into());
            }
        }
        Ok(())
    }
}
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(65_537).read_to_end(&mut bytes))
        .map_err(|_| "Cannot read local configuration.")?;
    if bytes.len() > 65_536 {
        return Err(INVALID.into());
    }
    // Explicit null must not silently erase a legacy password field.
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    if value
        .get("password")
        .is_some_and(serde_json::Value::is_null)
    {
        return Err(INVALID.into());
    }
    serde_json::from_value(value).map_err(|_| INVALID.into())
}
pub fn save_json<T: Serialize>(directory: &Path, name: &str, value: &T) -> Result<(), String> {
    let temporary = directory.join(format!("server-{}.local.json", random_token()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let bytes = serde_json::to_vec_pretty(value)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, directory.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
        .map_err(|_: std::io::Error| "Could not save local settings. Use a writable folder.".into())
}

#[derive(Debug)]
pub struct DataPaths {
    pub root: PathBuf,
    pub config: PathBuf,
    pub browser: PathBuf,
}
impl DataPaths {
    pub fn resolve(executable: &Path, development_root: Option<&Path>) -> Result<Self, String> {
        let root = match development_root {
            Some(project) => project.join(".tauri-dev-data"),
            None => executable
                .parent()
                .ok_or("Cannot locate application folder.")?
                .join("EmulatorRemote-data"),
        };
        Ok(Self {
            config: root.join("config"),
            browser: root.join("browser"),
            root,
        })
    }
}
