use crate::config::{has_control, random_token, valid_token};
use rand::{rngs::OsRng, RngCore};
use scrypt::{scrypt, Params};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PasswordHash {
    salt: [u8; 16],
    hash: [u8; 32],
}
impl PasswordHash {
    pub fn derive(password: &str) -> Result<Self, String> {
        if !(6..=128).contains(&password.encode_utf16().count()) || has_control(password) {
            return Err("Choose a password of 6–128 characters without control characters.".into());
        }
        let mut salt = [0; 16];
        OsRng.fill_bytes(&mut salt);
        Ok(Self {
            salt,
            hash: derive(password, &salt)?,
        })
    }
    pub fn verify(&self, password: &str) -> bool {
        derive(password, &self.salt).is_ok_and(|mut candidate| {
            let valid = bool::from(candidate.ct_eq(&self.hash));
            candidate.zeroize();
            valid
        })
    }
}
fn derive(password: &str, salt: &[u8; 16]) -> Result<[u8; 32], String> {
    let params = Params::new(14, 8, 1, 32).map_err(|_| "Password hashing unavailable.")?;
    let mut output = [0; 32];
    scrypt(password.as_bytes(), salt, &params, &mut output)
        .map_err(|_| "Password hashing failed.")?;
    Ok(output)
}

pub struct Sessions {
    password: PasswordHash,
    tokens: Mutex<HashMap<String, Instant>>,
    work: Arc<Semaphore>,
    active: AtomicBool,
}
#[derive(Debug, PartialEq)]
pub enum LoginError {
    Busy,
    Stopped,
}
impl Sessions {
    pub fn new(password: PasswordHash, work: Arc<Semaphore>) -> Self {
        Self {
            password,
            tokens: Mutex::new(HashMap::new()),
            work,
            active: AtomicBool::new(true),
        }
    }
    pub async fn login(self: &Arc<Self>, credential: String) -> Result<Option<String>, LoginError> {
        let credential = Zeroizing::new(credential);
        if !self.active.load(Ordering::SeqCst) {
            return Err(LoginError::Stopped);
        }
        if !(1..=128).contains(&credential.encode_utf16().count()) {
            return Ok(None);
        }
        {
            let mut tokens = self.tokens.lock().map_err(|_| LoginError::Stopped)?;
            tokens.retain(|_, expiry| *expiry > Instant::now());
            if tokens.len() >= 128 {
                return Err(LoginError::Busy);
            }
        }
        let permit = self
            .work
            .clone()
            .try_acquire_owned()
            .map_err(|_| LoginError::Busy)?;
        let password = self.password.clone();
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            password.verify(&credential)
        })
        .await
        .map_err(|_| LoginError::Busy)?;
        if !valid {
            return Ok(None);
        }
        let mut tokens = self.tokens.lock().map_err(|_| LoginError::Stopped)?;
        if !self.active.load(Ordering::SeqCst) {
            return Err(LoginError::Stopped);
        }
        tokens.retain(|_, expiry| *expiry > Instant::now());
        if tokens.len() >= 128 {
            return Err(LoginError::Busy);
        }
        let token = random_token();
        tokens.insert(
            token.clone(),
            Instant::now() + Duration::from_secs(12 * 60 * 60),
        );
        Ok(Some(token))
    }
    pub fn authenticate(&self, header: Option<&str>) -> bool {
        if !self.active.load(Ordering::SeqCst) {
            return false;
        }
        let Some(token) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
            return false;
        };
        if !valid_token(token) {
            return false;
        }
        let Ok(mut tokens) = self.tokens.lock() else {
            return false;
        };
        tokens.retain(|_, expiry| *expiry > Instant::now());
        tokens.contains_key(token)
    }
    pub fn logout(&self, header: Option<&str>) {
        if let Some(token) = header.and_then(|h| h.strip_prefix("Bearer ")) {
            if let Ok(mut tokens) = self.tokens.lock() {
                tokens.remove(token);
            }
        }
    }
    pub fn clear(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_matches_node_scrypt_parameters() {
        // Node crypto.scryptSync(password, Buffer.alloc(16), 32, {N:16384,r:8,p:1}).
        let actual = derive("test-password", &[0; 16]).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "acec01ab38bb7a9f2d7fa343a6552b78cd0d74679e6c9c3771b2f7173b2ff558"
        );
        let hash = PasswordHash {
            salt: [0; 16],
            hash: actual,
        };
        assert!(hash.verify("test-password"));
        assert!(!hash.verify("wrong-password"));
    }
    #[tokio::test]
    async fn expiry_logout_and_shutdown_revoke_sessions() {
        let sessions = Arc::new(Sessions::new(
            PasswordHash::derive("secret-password").unwrap(),
            Arc::new(Semaphore::new(2)),
        ));
        assert!(sessions
            .login("wrong-password".into())
            .await
            .unwrap()
            .is_none());
        let token = sessions
            .login("secret-password".into())
            .await
            .unwrap()
            .unwrap();
        let header = format!("Bearer {token}");
        assert!(sessions.authenticate(Some(&header)));
        sessions
            .tokens
            .lock()
            .unwrap()
            .insert(token.clone(), Instant::now());
        assert!(!sessions.authenticate(Some(&header)));
        sessions
            .tokens
            .lock()
            .unwrap()
            .insert(token, Instant::now() + Duration::from_secs(60));
        sessions.logout(Some(&header));
        assert!(!sessions.authenticate(Some(&header)));
        sessions.clear();
        assert_eq!(
            sessions.login("secret-password".into()).await,
            Err(LoginError::Stopped)
        );
    }
}
