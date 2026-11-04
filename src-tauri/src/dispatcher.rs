use crate::{
    config::Profiles,
    http::ActionRequest,
    input::{InputAdapter, InputError, Shortcut, SAFE_REJECTIONS},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq)]
pub struct ActionResult {
    pub status: u16,
    pub body: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::InputFuture;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::Semaphore;
    struct FakeInput {
        live: AtomicBool,
        sent: AtomicUsize,
        gate: Semaphore,
        result: Mutex<Result<(), InputError>>,
        shortcuts: Mutex<Vec<Shortcut>>,
    }
    impl FakeInput {
        fn new(permits: usize, result: Result<(), InputError>) -> Arc<Self> {
            Arc::new(Self {
                live: AtomicBool::new(true),
                sent: AtomicUsize::new(0),
                gate: Semaphore::new(permits),
                result: Mutex::new(result),
                shortcuts: Mutex::new(vec![]),
            })
        }
        async fn wait_sent(&self) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while self.sent.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    impl InputAdapter for FakeInput {
        fn available(&self) -> bool {
            self.live.load(Ordering::SeqCst)
        }
        fn send(&self, shortcut: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
            Box::pin(async move {
                self.shortcuts.lock().unwrap().push(shortcut);
                self.sent.fetch_add(1, Ordering::SeqCst);
                self.gate.acquire().await.unwrap().forget();
                self.result.lock().unwrap().clone()
            })
        }
        fn close(&self) -> InputFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.live.store(false, Ordering::SeqCst);
                self.gate.add_permits(1);
                Ok(())
            })
        }
    }
    fn profiles() -> Profiles {
        serde_json::from_str::<Profiles>(include_str!("../../config/profiles.example.json"))
            .unwrap()
            .validate()
            .unwrap()
    }
    fn request(id: usize, action: &str) -> ActionRequest {
        ActionRequest {
            request_id: format!("00000000-0000-4000-8000-{id:012x}"),
            profile_id: "pcsx2".into(),
            action: action.into(),
        }
    }
    #[tokio::test]
    async fn deduplicates_success_and_rejects_conflicting_ids() {
        let input = FakeInput::new(10, Ok(()));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        let first = dispatcher.dispatch(request(1, "previousSlot")).await;
        assert_eq!(first.status, 200);
        assert_eq!(dispatcher.dispatch(request(1, "previousSlot")).await, first);
        assert_eq!(
            dispatcher.dispatch(request(1, "loadState")).await.body["code"],
            "request_conflict"
        );
        assert_eq!(input.sent.load(Ordering::SeqCst), 1);
        let sent = input.shortcuts.lock().unwrap();
        assert_eq!(sent[0].key, "F2");
        assert_eq!(sent[0].modifiers, vec!["Shift"]);
        assert_eq!(sent[0].allowed_processes, vec!["pcsx2-qt.exe"]);
    }
    #[tokio::test]
    async fn disconnected_caller_does_not_cancel_operation_or_deduplication() {
        let input = FakeInput::new(0, Ok(()));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        let task = dispatcher.clone();
        let caller = tokio::spawn(async move { task.dispatch(request(1, "saveState")).await });
        input.wait_sent().await;
        caller.abort();
        assert_eq!(
            dispatcher.dispatch(request(1, "saveState")).await.body["code"],
            "busy"
        );
        assert_eq!(
            dispatcher.dispatch(request(2, "loadState")).await.body["code"],
            "busy"
        );
        input.gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let cached = dispatcher.dispatch(request(1, "saveState")).await;
                if cached.status == 200 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(input.sent.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn safe_rejections_are_cached_but_fatal_errors_disable_until_restart() {
        for code in SAFE_REJECTIONS {
            let input = FakeInput::new(10, Err(InputError::Rejected(code.into())));
            let dispatcher = Dispatcher::new(profiles(), input.clone());
            let result = dispatcher.dispatch(request(1, "saveState")).await;
            assert_eq!(result.status, 409);
            assert_eq!(result.body["code"], code);
            assert!(dispatcher.available());
            assert_eq!(dispatcher.dispatch(request(1, "saveState")).await, result);
            assert_eq!(input.sent.load(Ordering::SeqCst), 1);
        }
        let input = FakeInput::new(10, Err(InputError::Rejected("invalid_request".into())));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        assert_eq!(
            dispatcher.dispatch(request(1, "saveState")).await.status,
            503
        );
        assert!(!dispatcher.available());
        assert_eq!(
            dispatcher.dispatch(request(2, "saveState")).await.status,
            503
        );
        assert_eq!(input.sent.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn deadline_disables_and_closes_adapter_without_retry() {
        let input = FakeInput::new(0, Ok(()));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        assert_eq!(
            dispatcher.dispatch(request(1, "saveState")).await.status,
            503
        );
        assert!(!input.available());
        assert!(!dispatcher.available());
        assert_eq!(
            dispatcher.dispatch(request(1, "saveState")).await.status,
            503
        );
        assert_eq!(input.sent.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cache_rejects_capacity_and_expires_completed_entries() {
        let input = FakeInput::new(600, Ok(()));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        for id in 0..512 {
            assert_eq!(
                dispatcher.dispatch(request(id, "saveState")).await.status,
                200
            );
        }
        assert_eq!(
            dispatcher.dispatch(request(513, "saveState")).await.body["code"],
            "request_capacity"
        );
        for entry in dispatcher.state.lock().unwrap().entries.values_mut() {
            entry.expires = Instant::now();
        }
        assert_eq!(
            dispatcher.dispatch(request(513, "saveState")).await.status,
            200
        );
        assert_eq!(input.sent.load(Ordering::SeqCst), 513);
    }

    #[tokio::test]
    async fn unexpected_adapter_panic_disables_and_caches_unknown_outcome() {
        struct Panicking(AtomicBool);
        impl InputAdapter for Panicking {
            fn available(&self) -> bool {
                self.0.load(Ordering::SeqCst)
            }
            fn send(&self, _: Shortcut) -> InputFuture<'_, Result<(), InputError>> {
                Box::pin(async { panic!("simulated adapter failure") })
            }
            fn close(&self) -> InputFuture<'_, Result<(), String>> {
                Box::pin(async move {
                    self.0.store(false, Ordering::SeqCst);
                    Ok(())
                })
            }
        }
        let input = Arc::new(Panicking(AtomicBool::new(true)));
        let dispatcher = Dispatcher::new(profiles(), input.clone());
        let result = dispatcher.dispatch(request(1, "saveState")).await;
        assert_eq!(result.status, 503);
        assert!(!input.available());
        assert_eq!(dispatcher.dispatch(request(1, "saveState")).await, result);
    }
}
fn error(status: u16, code: &str, message: &str) -> ActionResult {
    ActionResult {
        status,
        body: json!({"code":code,"message":message}),
    }
}
struct Entry {
    target: (String, String),
    expires: Instant,
    result: Option<ActionResult>,
}
struct State {
    busy: bool,
    entries: HashMap<String, Entry>,
}
pub struct Dispatcher {
    profiles: Profiles,
    input: Arc<dyn InputAdapter>,
    state: Mutex<State>,
    disabled: AtomicBool,
    cleanup: tokio::sync::Mutex<()>,
    cleanup_error: Mutex<Option<String>>,
}
impl Dispatcher {
    pub fn new(profiles: Profiles, input: Arc<dyn InputAdapter>) -> Arc<Self> {
        Arc::new(Self {
            profiles,
            input,
            state: Mutex::new(State {
                busy: false,
                entries: HashMap::new(),
            }),
            disabled: AtomicBool::new(false),
            cleanup: tokio::sync::Mutex::new(()),
            cleanup_error: Mutex::new(None),
        })
    }
    pub fn available(&self) -> bool {
        !self.disabled.load(Ordering::SeqCst) && self.input.available()
    }
    pub async fn dispatch(self: &Arc<Self>, request: ActionRequest) -> ActionResult {
        // Own the operation independently of the HTTP connection. Disconnecting
        // or timing out a phone request must not erase its result or busy lock.
        let dispatcher = self.clone();
        let request_id = request.request_id.clone();
        match tokio::spawn(async move { dispatcher.perform(request).await }).await {
            Ok(result) => result,
            Err(_) => {
                self.disabled.store(true, Ordering::SeqCst);
                let _ = self.close().await;
                let result = error(
                    503,
                    "input_unavailable",
                    "Outcome unknown. Check the emulator before restarting.",
                );
                if let Ok(mut state) = self.state.lock() {
                    if let Some(entry) = state.entries.get_mut(&request_id) {
                        entry.result = Some(result.clone());
                        entry.expires = Instant::now() + Duration::from_secs(60);
                    }
                    state.busy = false;
                }
                result
            }
        }
    }
    async fn perform(&self, request: ActionRequest) -> ActionResult {
        let shortcut = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    return error(
                        503,
                        "input_unavailable",
                        "Input unavailable; restart required.",
                    )
                }
            };
            let now = Instant::now();
            state
                .entries
                .retain(|_, entry| entry.result.is_none() || entry.expires > now);
            let target = (request.profile_id.clone(), request.action.clone());
            if let Some(entry) = state.entries.get(&request.request_id) {
                return if entry.target != target {
                    error(
                        409,
                        "request_conflict",
                        "Request ID was used for a different action.",
                    )
                } else {
                    entry.result.clone().unwrap_or_else(|| {
                        error(409, "busy", "This request is already in progress.")
                    })
                };
            }
            let Some(profile) = self
                .profiles
                .profiles
                .iter()
                .find(|p| p.id == request.profile_id)
            else {
                return error(404, "profile_not_found", "Profile not found.");
            };
            let Some(chord) = profile.actions.get(&request.action) else {
                return error(
                    400,
                    "action_not_configured",
                    "This control has no configured shortcut.",
                );
            };
            if !self.available() {
                return error(
                    503,
                    "input_unavailable",
                    "Input unavailable; restart required.",
                );
            }
            if state.busy {
                return error(409, "busy", "An action is in progress.");
            }
            if state.entries.len() >= 512 {
                return error(429, "request_capacity", "Too many recent requests.");
            }
            state.entries.insert(
                request.request_id.clone(),
                Entry {
                    target,
                    expires: now + Duration::from_secs(60),
                    result: None,
                },
            );
            state.busy = true;
            Shortcut {
                allowed_processes: profile.process_names.clone(),
                key: chord.key.clone(),
                modifiers: chord.modifiers.clone(),
            }
        };
        let result =
            match tokio::time::timeout(Duration::from_secs(2), self.input.send(shortcut)).await {
                Ok(Ok(())) => ActionResult {
                    status: 200,
                    body: json!({"requestId":request.request_id,"status":"sent"}),
                },
                Ok(Err(InputError::Rejected(code))) if SAFE_REJECTIONS.contains(&code.as_str()) => {
                    error(
                        409,
                        &code,
                        "Shortcut rejected. Focus the emulator and release held keys.",
                    )
                }
                _ => {
                    self.disabled.store(true, Ordering::SeqCst);
                    let _ = self.close().await;
                    error(
                        503,
                        "input_unavailable",
                        "Outcome unknown. Check the emulator before restarting.",
                    )
                }
            };
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.entries.get_mut(&request.request_id) {
                entry.result = Some(result.clone());
                entry.expires = Instant::now() + Duration::from_secs(60);
            }
            state.busy = false;
        }
        result
    }
    pub async fn close(&self) -> Result<(), String> {
        self.disabled.store(true, Ordering::SeqCst);
        let _cleanup = self.cleanup.lock().await;
        let result = self.input.close().await;
        if let Err(error) = result {
            *self
                .cleanup_error
                .lock()
                .map_err(|_| "Input cleanup state unavailable.")? = Some(error);
        }
        match self
            .cleanup_error
            .lock()
            .map_err(|_| "Input cleanup state unavailable.")?
            .clone()
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
