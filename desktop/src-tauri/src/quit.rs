//! Quitting and closing the window work like Esc (decision D-21). Every way out
//! of the app first runs the page's quit hook, window.__plainSightQuit
//! (adapter.js): it awaits the callback the page registered with onQuit, which
//! is Esc's wipe plus the vault's last write, and then calls quit_ready. The app
//! ends after that, or after a 4-second safety timer, and always through
//! AppKit's normal termination, so that WebKit sees the app end.
//!
//! The ways out:
//! - closing the window (the red button, Close Window, Cmd+W): main.rs keeps
//!   the window open and calls begin;
//! - the app menu's Quit item, Cmd+Q (menu.rs): begin;
//! - a terminate request from macOS (the Dock's Quit, logout, restart,
//!   shutdown): applicationShouldTerminate: answers "later" until the page is
//!   done, then "now". It never answers "cancel", which would cancel a logout.

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// How long the page gets before the app ends anyway: the adapter's longest
/// path (1.8 s for the page's callback, 0.4 s for the storage answer, 0.7 s
/// for WebKit's commit) and a full second of margin for a loaded Mac, where
/// WebKit's timers run late while this one is a precise sleep (D-42,
/// `Mac_PS_008`). `tests/adapter.mjs` holds the two files to that sum.
const SAFETY: Duration = Duration::from_secs(4);

/// Runs the page's hook; does nothing if the adapter is missing.
const HOOK: &str = "window.__plainSightQuit && window.__plainSightQuit()";

static STATE: Mutex<QuitState> = Mutex::new(QuitState::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Where a quit stands. Plain state with no AppKit in it, so it is unit-tested.
#[derive(Debug, Default)]
pub struct QuitState {
    /// The page's hook has been started.
    begun: bool,
    /// The page is done, or the timer fired: the app may end.
    approved: bool,
    /// macOS asked to terminate and is waiting for an answer.
    terminate_pending: bool,
}

/// How the app ends once the page is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// Answer the waiting terminate request with yes.
    Reply,
    /// Ask macOS to terminate; the request is then answered with "now".
    Terminate,
}

/// The answer to macOS's applicationShouldTerminate:.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Now,
    /// Later; `begin` is true when this request is what started the quit.
    Later {
        begin: bool,
    },
}

impl QuitState {
    pub const fn new() -> Self {
        QuitState {
            begun: false,
            approved: false,
            terminate_pending: false,
        }
    }

    /// Starts a quit. True only the first time: the caller then runs the hook.
    pub fn begin(&mut self) -> bool {
        let first = !self.begun;
        self.begun = true;
        first
    }

    /// macOS asks whether the app may terminate now.
    pub fn should_terminate(&mut self) -> Answer {
        if self.approved {
            return Answer::Now;
        }
        self.terminate_pending = true;
        Answer::Later {
            begin: self.begin(),
        }
    }

    /// The page is done, or the timer fired. How to end the app, the first
    /// time after a begin; None before a begin and after the first finish.
    pub fn finish(&mut self) -> Option<Ending> {
        if !self.begun || self.approved {
            return None;
        }
        self.approved = true;
        Some(if self.terminate_pending {
            Ending::Reply
        } else {
            Ending::Terminate
        })
    }
}

fn state() -> MutexGuard<'static, QuitState> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Called once at start, on the main thread.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    if let Err(reason) = macos::install() {
        eprintln!("{}", not_installed(&reason));
    }
}

/// The line on stderr when `applicationShouldTerminate:` could not be added
/// to the app's delegate (`Mac_PS_007`): it names the consequence, so that a
/// log reader knows what the Dock's Quit would then do.
fn not_installed(reason: &str) -> String {
    format!(
        "plain-sight: applicationShouldTerminate: is not installed ({reason}): a terminate \
         request from macOS (the Dock's Quit, a logout, a shutdown) would end the app at once, \
         before the page's Esc and the vault's last write"
    )
}

/// Starts a quit from the window close or the Quit item.
pub fn begin(app: &AppHandle) {
    let first = state().begin();
    if first {
        run_hook(app);
    }
}

/// Asks the page to finish and starts the safety timer.
fn run_hook(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(HOOK);
    }
    std::thread::spawn(|| {
        std::thread::sleep(SAFETY);
        finish();
    });
}

/// Ends the app if a quit is waiting for the page; true if this call did.
fn finish() -> bool {
    let ending = state().finish();
    match ending {
        Some(ending) => {
            end(ending);
            true
        }
        None => false,
    }
}

/// The page's hook is done. Refused when no quit is in progress, so the page
/// cannot end the app by itself.
#[tauri::command]
pub fn quit_ready() -> Result<(), String> {
    if finish() {
        Ok(())
    } else {
        Err("No quit is in progress".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn end(ending: Ending) {
    macos::end(ending);
}

#[cfg(not(target_os = "macos"))]
fn end(_ending: Ending) {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::ffi::CStr;

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use objc2_core_foundation::{kCFRunLoopCommonModes, CFRunLoop};

    use super::{state, Answer, Ending, APP};

    /// applicationShouldTerminate: as a Rust function: self, the selector and
    /// the sending NSApplication in, an NSApplicationTerminateReply out.
    type ShouldTerminate = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize;

    /// tao's app delegate (tao 0.37.1, src/platform_impl/macos/app_delegate.rs)
    /// has no applicationShouldTerminate:, so a terminate request would end the
    /// app at once. This adds the method to tao's delegate class. The error
    /// names what stopped it: a tao that renamed the class, or one that gained
    /// the method itself, would otherwise bring the instant end back in
    /// silence (`Mac_PS_007`).
    pub fn install() -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not called on the main thread")?;
        add_should_terminate(c"TaoAppDelegateParent")?;
        // AppKit may note which methods a delegate has when the delegate is set;
        // setting the same delegate again lets it see the new one.
        let app = NSApplication::sharedApplication(mtm);
        app.setDelegate(app.delegate().as_deref());
        Ok(())
    }

    /// Adds `applicationShouldTerminate:` to the class, and reads the
    /// runtime's answer: it refuses when the class has the method already.
    pub(super) fn add_should_terminate(name: &CStr) -> Result<(), String> {
        let shown = name.to_string_lossy();
        let class = AnyClass::get(name)
            .ok_or_else(|| format!("the delegate class {shown} does not exist"))?;
        let method: ShouldTerminate = should_terminate;
        // SAFETY: `method` has the method's Objective-C signature, encoded
        // "Q@:@": it returns NSApplicationTerminateReply (an NSUInteger) and
        // takes self, the selector and the sending NSApplication.
        let added = unsafe {
            let imp = std::mem::transmute::<ShouldTerminate, Imp>(method);
            let class = std::ptr::from_ref(class).cast_mut();
            ffi::class_addMethod(
                class,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            return Err(format!(
                "the runtime refused to add applicationShouldTerminate: to {shown}, which has the method already"
            ));
        }
        Ok(())
    }

    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        // Before the app has started there is no page to wait for.
        let Some(app) = APP.get() else {
            return NSApplicationTerminateReply::TerminateNow.0;
        };
        let answer = state().should_terminate();
        match answer {
            Answer::Now => NSApplicationTerminateReply::TerminateNow.0,
            Answer::Later { begin } => {
                if begin {
                    super::run_hook(app);
                }
                NSApplicationTerminateReply::TerminateLater.0
            }
        }
    }

    /// Ends the app through AppKit, from the main run loop.
    pub fn end(ending: Ending) {
        on_main_run_loop(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let app = NSApplication::sharedApplication(mtm);
            match ending {
                Ending::Reply => app.replyToApplicationShouldTerminate(true),
                Ending::Terminate => app.terminate(None),
            }
        });
    }

    /// Runs `work` on the main thread from the main run loop, in its common
    /// modes. It runs outside tao's event handler: tao's
    /// applicationWillTerminate: calls that handler again, and it is not
    /// re-entrant (tao 0.37.1, src/platform_impl/macos/app_state.rs lines 203
    /// to 218 and 272 to 282). It also runs while AppKit waits for a terminate
    /// answer, in NSModalPanelRunLoopMode, even when the terminate came from a
    /// main-queue block, where the main queue itself would not run.
    pub(crate) fn on_main_run_loop(work: impl Fn() + Send + 'static) {
        let Some(run_loop) = CFRunLoop::main() else {
            return;
        };
        let block = RcBlock::new(work);
        // SAFETY: the mode is the common modes string and the block takes no
        // arguments; the run loop copies the block before this returns.
        unsafe {
            let mode = kCFRunLoopCommonModes.map(|mode| &**mode);
            run_loop.perform_block(mode, Some(&block));
        }
        run_loop.wake_up();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quit_begins_once() {
        let mut quit = QuitState::new();
        assert!(quit.begin(), "the first begin runs the page's hook");
        assert!(
            !quit.begin(),
            "a second close or Cmd+Q does not run it again"
        );
    }

    #[test]
    fn a_quit_finishes_once_and_only_after_it_began() {
        let mut quit = QuitState::new();
        assert_eq!(
            quit.finish(),
            None,
            "quit_ready with no quit in progress is refused"
        );
        quit.begin();
        assert_eq!(
            quit.finish(),
            Some(Ending::Terminate),
            "a close or Quit item asks macOS to terminate"
        );
        assert_eq!(
            quit.finish(),
            None,
            "the page and the timer cannot both end the app"
        );
    }

    #[test]
    fn a_terminate_request_waits_for_the_page_and_is_then_answered() {
        let mut quit = QuitState::new();
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: true },
            "the request starts the quit"
        );
        assert_eq!(quit.should_terminate(), Answer::Later { begin: false });
        assert_eq!(
            quit.finish(),
            Some(Ending::Reply),
            "the waiting request gets its yes"
        );
        assert_eq!(quit.should_terminate(), Answer::Now);
    }

    #[test]
    fn a_terminate_during_a_close_is_answered_when_the_page_is_done() {
        let mut quit = QuitState::new();
        assert!(quit.begin(), "the window was closed");
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: false },
            "the hook is not run twice"
        );
        assert_eq!(quit.finish(), Some(Ending::Reply));
    }

    #[test]
    fn once_approved_the_terminate_that_follows_goes_ahead() {
        let mut quit = QuitState::new();
        quit.begin();
        assert_eq!(quit.finish(), Some(Ending::Terminate));
        assert_eq!(
            quit.should_terminate(),
            Answer::Now,
            "terminate: after the page is done ends the app"
        );
        assert_eq!(quit.finish(), None);
    }

    #[test]
    fn a_missing_method_is_reported_with_its_consequence() {
        let line = not_installed("the reason");
        assert!(line.starts_with("plain-sight: "), "{line}");
        assert!(line.contains("(the reason)"), "{line}");
        assert!(line.contains("would end the app at once"), "{line}");
    }

    /// The method is added to a class made here (tao's delegate class exists
    /// only in the app), and the runtime's answer is read: a class that has
    /// the method already is refused, and a class that does not exist is named.
    #[cfg(target_os = "macos")]
    #[test]
    fn install_reads_the_runtimes_answer_and_names_what_stopped_it() {
        use objc2::runtime::{AnyClass, ClassBuilder, NSObject};
        use objc2::{sel, ClassType};
        let name = c"PlainSightTestDelegate";
        let builder = ClassBuilder::new(name, NSObject::class()).unwrap();
        let class = builder.register();
        assert!(
            class
                .instance_method(sel!(applicationShouldTerminate:))
                .is_none(),
            "a fresh class has no such method"
        );
        assert_eq!(macos::add_should_terminate(name), Ok(()));
        assert!(
            class
                .instance_method(sel!(applicationShouldTerminate:))
                .is_some(),
            "the method was added"
        );
        assert_eq!(
            macos::add_should_terminate(name),
            Err("the runtime refused to add applicationShouldTerminate: to PlainSightTestDelegate, which has the method already".to_owned())
        );
        assert_eq!(
            macos::add_should_terminate(c"PlainSightNoSuchDelegate"),
            Err("the delegate class PlainSightNoSuchDelegate does not exist".to_owned())
        );
        assert!(
            AnyClass::get(c"TaoAppDelegateParent").is_none(),
            "tao's class is not in a unit test"
        );
        let off_main = std::thread::spawn(macos::install).join().unwrap();
        assert_eq!(off_main, Err("not called on the main thread".to_owned()));
    }
}
