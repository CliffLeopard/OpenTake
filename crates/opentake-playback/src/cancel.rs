//! Cooperative cancellation token shared by producers and the engine.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One-shot cancellation flag. `Clone` shares the same underlying flag.
#[derive(Clone, Debug, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
}
