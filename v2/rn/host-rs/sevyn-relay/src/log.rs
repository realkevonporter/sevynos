//! Timestamped logging. One sink: stderr by default, or the file
//! named by `--log-file`. Every line is `<iso> RELAY <message>`.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;

use crate::timeutil::iso_now;

static SINK: Mutex<Option<File>> = Mutex::new(None);

/// Point the logger at a file (append). Call once at startup; if
/// never called, lines go to stderr.
pub fn init_file(path: &str) -> std::io::Result<()> {
    let f = OpenOptions::new().create(true).append(true).open(path)?;
    *SINK.lock().unwrap() = Some(f);
    Ok(())
}

pub fn log(msg: &str) {
    let line = format!("{} RELAY {}\n", iso_now(), msg);
    let mut guard = SINK.lock().unwrap();
    match guard.as_mut() {
        Some(f) => {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
        None => {
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }
}

/// Format helper so call sites read `logf!("...")`.
#[macro_export]
macro_rules! logf {
    ($($arg:tt)*) => {
        $crate::log::log(&format!($($arg)*))
    };
}
