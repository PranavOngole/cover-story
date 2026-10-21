//! Where Save writes. With a folder chosen (decision D-07), the page asks for it
//! through the system picker and then writes plain text files named by the
//! moment into it. The folder's path stays here: the page only ever gets the
//! folder's name, and it can only write `.txt` files named
//! "YYYY-MM-DD HH-MM-SS" into the folder the user picked. Without a folder,
//! Save writes the page's own download into the Downloads folder through
//! `save_download`, so the page learns whether the file was really written
//! (DM-202).

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Manager, Runtime, State, WebviewWindow};

/// The remembered folder, in memory and in a small file in the app's data
/// directory so that it survives a quit.
pub struct Folder {
    /// Where the choice is kept on disk; None if the data directory is unknown.
    file: Option<PathBuf>,
    /// The folder. Writes hold the lock, so two saves run one after the other.
    path: Mutex<Option<PathBuf>>,
}

impl Folder {
    /// Reads the choice once, at start. A folder that no longer exists is still
    /// remembered: an unplugged drive may come back, and until then a write
    /// fails and the page says so.
    pub fn load(data_dir: Option<PathBuf>) -> Self {
        let file = data_dir.map(|dir| dir.join("folder.txt"));
        let path = file
            .as_deref()
            .and_then(|file| fs::read_to_string(file).ok())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute()); // never a path relative to wherever the app runs
        Folder {
            file,
            path: Mutex::new(path),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<PathBuf>>, String> {
        self.path
            .lock()
            .map_err(|_| "The folder is not available".to_owned())
    }

    /// Remembers a newly chosen folder, on disk first and then in memory.
    fn remember(&self, path: PathBuf) -> Result<Shown, String> {
        let file = self
            .file
            .as_deref()
            .ok_or("The app's data folder is not available")?;
        let mut current = self.lock()?;
        store(file, &path).map_err(|e| format!("Could not remember the folder: {e}"))?;
        let shown = Shown::of(&path);
        *current = Some(path);
        Ok(shown)
    }

    fn shown(&self) -> Result<Option<Shown>, String> {
        Ok(self.lock()?.as_deref().map(Shown::of))
    }

    /// Forgets the folder, on disk first and then in memory, so a failure
    /// leaves it remembered in both and the page, which keeps showing it,
    /// still agrees with the app (DM-220).
    fn forget(&self) -> Result<(), String> {
        let mut current = self.lock()?;
        if let Some(Err(e)) = self.file.as_deref().map(fs::remove_file) {
            if e.kind() != ErrorKind::NotFound {
                return Err(format!("Could not forget the folder: {e}"));
            }
        }
        *current = None;
        Ok(())
    }

    /// Writes the text into the folder as `<base>.txt`, numbered if that name
    /// is taken, and returns the file name used. The lock is held while
    /// writing, so two saves in the same second are written one after the other.
    fn write(&self, base: &str, text: &str) -> Result<String, String> {
        if !is_moment(base) {
            return Err("The file name must be a moment, YYYY-MM-DD HH-MM-SS".to_owned());
        }
        let current = self.lock()?;
        let dir = current.as_deref().ok_or("No folder is chosen")?;
        write_new(dir, &format!("{base}.txt"), text)
            .map_err(|e| format!("Could not write the file: {e}"))
    }
}

/// What the page may know about a folder: its name, never its path.
#[derive(Serialize)]
pub struct Shown {
    name: String,
}

impl Shown {
    fn of(path: &Path) -> Self {
        let name = path.file_name().unwrap_or(path.as_os_str());
        Shown {
            name: name.to_string_lossy().into_owned(),
        }
    }
}

// The folder commands the page may call (build.rs, capabilities/main.json).
// Each one only hands over to the Folder above, where the rules are and are
// tested; save_download, below, writes into the Downloads folder.

/// Shows the system folder picker. On a choice the folder is remembered and
/// its name returned; Cancel returns None and changes nothing.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(
    window: WebviewWindow<R>,
    folder: State<'_, Folder>,
) -> Result<Option<Shown>, String> {
    match choose(window).await? {
        Some(path) => folder.remember(path).map(Some),
        None => Ok(None),
    }
}

/// The folder remembered from an earlier run, or None.
#[tauri::command(async)]
pub fn saved_folder(folder: State<'_, Folder>) -> Result<Option<Shown>, String> {
    folder.shown()
}

#[tauri::command(async)]
pub fn forget_folder(folder: State<'_, Folder>) -> Result<(), String> {
    folder.forget()
}

#[tauri::command(async)]
pub fn write_text_file(
    base: String,
    text: String,
    folder: State<'_, Folder>,
) -> Result<String, String> {
    folder.write(&base, &text)
}

/// Save without a folder: writes the page's file into the Downloads folder
/// under the page's own name, numbered when that name is taken, and returns the
/// name used. A failure reaches the page, which then says it could not save.
#[tauri::command(async)]
pub fn save_download<R: Runtime>(
    window: WebviewWindow<R>,
    name: String,
    text: String,
) -> Result<String, String> {
    if !is_download_name(&name) {
        return Err("The file name is not one Save makes".to_owned());
    }
    let downloads = window
        .path()
        .download_dir()
        .map_err(|_| "The Downloads folder is not available".to_owned())?;
    write_new(&downloads, &name, &text).map_err(|e| format!("Could not save the file: {e}"))
}

/// A name Save gives a download, and nothing else: "YYYY-MM-DD HH-MM-SS.txt",
/// or a cover's title in lower case with hyphens followed by
/// "-YYYYMMDD-HHMM.sight" (index.html, onSave).
fn is_download_name(name: &str) -> bool {
    if let Some(stem) = name.strip_suffix(".txt") {
        return is_moment(stem);
    }
    let Some(stem) = name.strip_suffix(".sight") else {
        return false;
    };
    // "-YYYYMMDD-HHMM" is the last 14 characters; the title comes before it.
    const STAMP: &[u8] = b"-00000000-0000";
    if !stem.is_ascii() || stem.len() <= STAMP.len() {
        return false;
    }
    let (title, stamp) = stem.split_at(stem.len() - STAMP.len());
    let stamp_ok = stamp.bytes().zip(STAMP).all(|(b, &s)| {
        if s == b'0' {
            b.is_ascii_digit()
        } else {
            b == s
        }
    });
    let title_ok = title.len() <= 60
        && !title.starts_with('-')
        && !title.ends_with('-')
        && !title.contains("--")
        && title
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    stamp_ok && title_ok
}

/// The system folder picker: folders only, a sheet on the document window,
/// starting in Documents, with a New Folder button. None when cancelled.
async fn choose<R: Runtime>(window: WebviewWindow<R>) -> Result<Option<PathBuf>, String> {
    // Test builds only: the end-to-end tests run while the screen is locked,
    // where no panel can be used, so they name the folder in the environment.
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("PLAIN_SIGHT_E2E_PICK").map(PathBuf::from) {
        return match path.is_absolute() {
            true => Ok(Some(path)),
            false => Err("PLAIN_SIGHT_E2E_PICK must be an absolute path".to_owned()),
        };
    }
    let start = window.path().document_dir().ok();
    let parent = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    // AppKit panels belong to the main thread: rfd builds the panel and starts
    // the sheet there (as tauri-plugin-dialog does) and hands back a future
    // that completes when the user chooses or cancels.
    window
        .run_on_main_thread(move || {
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_parent(&parent)
                .set_title("Choose the folder Save writes into")
                .set_can_create_directories(true);
            if let Some(start) = start {
                dialog = dialog.set_directory(start);
            }
            let _ = sender.try_send(dialog.pick_folder());
        })
        .map_err(|e| e.to_string())?;
    let chosen = receiver
        .recv()
        .await
        .ok_or("The folder picker did not open")?;
    Ok(chosen.await.map(|handle| handle.path().to_path_buf()))
}

/// Keeps the folder's path in `file` atomically: a temporary file in the same
/// directory, flushed to disk, then renamed over the old one, so a crash never
/// leaves half a path behind.
fn store(file: &Path, folder: &Path) -> io::Result<()> {
    let text = folder
        .to_str()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "path is not UTF-8"))?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = file.with_extension("tmp");
    let mut out = fs::File::create(&temp)?;
    out.write_all(text.as_bytes())?;
    out.sync_all()?;
    fs::rename(&temp, file)
}

/// The page's rule for file names (index.html, folderWrite): the name itself,
/// then " (2)", " (3)" and so on up to " (99)" before the extension. Folder
/// files and downloads both take the first of these that is free.
pub fn numbered(name: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    std::iter::once(name.to_owned())
        .chain((2..=99).map(move |n| format!("{stem} ({n}){extension}")))
}

/// A base name the page may write: exactly the moment "YYYY-MM-DD HH-MM-SS".
/// Nothing else gets through: no path, no extension, no other name.
fn is_moment(base: &str) -> bool {
    const SHAPE: &[u8] = b"0000-00-00 00-00-00";
    base.len() == SHAPE.len()
        && base.bytes().zip(SHAPE).all(|(b, &s)| {
            if s == b'0' {
                b.is_ascii_digit()
            } else {
                b == s
            }
        })
}

/// Writes `text` into a new file in `dir` under the first free name and returns
/// that name. create_new makes the system itself refuse a name that exists,
/// even one another save created a moment ago, so no file is ever overwritten.
fn write_new(dir: &Path, name: &str, text: &str) -> io::Result<String> {
    for candidate in numbered(name) {
        let path = dir.join(&candidate);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        // One write, then wait for the disk, so a reported save is really on it.
        if let Err(e) = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
        {
            let _ = fs::remove_file(&path); // a failed save leaves no partial file
            return Err(e);
        }
        return Ok(candidate);
    }
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "every name up to (99) is taken",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "2026-10-20 14-55-03";

    /// A fresh, empty directory for one test.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plain-sight-unit-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_names_save_makes_are_accepted_as_downloads() {
        for good in [
            "2026-10-20 14-55-03.txt",
            "untitled-draft-20261020-1455.sight",
            "q3-planning-notes-20261020-1455.sight",
            "manuscript-draft-20261020-1455.sight",
            "draft-20261020-1455.sight",
        ] {
            assert!(is_download_name(good), "{good} is a name Save makes");
        }
        for bad in [
            "",
            ".sight",
            "-20261020-1455.sight",
            "untitled-draft-20261020-1455.txt",
            "untitled-draft-2026102-14550.sight",
            "Untitled-draft-20261020-1455.sight",
            "untitled--draft-20261020-1455.sight",
            "untitled-draft--20261020-1455.sight",
            "../untitled-draft-20261020-1455.sight",
            "a/b-20261020-1455.sight",
            "untitled draft-20261020-1455.sight",
            "untitled-draft-20261020-1455.sight.exe",
            "untitled-draft-20261020-1455 (2).sight",
            "2026-10-20 14-55-03 (2).txt",
            "2026-10-20 14-55-03.TXT",
            "notes.sh",
            "\u{e9}t\u{e9}-20261020-1455.sight",
        ] {
            assert!(!is_download_name(bad), "{bad:?} is refused");
        }
        let long = format!("{}-20261020-1455.sight", "a".repeat(61));
        assert!(
            !is_download_name(&long),
            "a title longer than 60 characters is refused"
        );
    }

    #[test]
    fn the_first_free_name_is_the_name_itself() {
        let dir = scratch("first");
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.txt", "one").unwrap(),
            "2026-10-20 14-55-03.txt"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_counter_follows_the_names_already_taken() {
        let dir = scratch("counter");
        for name in [
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-03 (2).txt",
            "2026-10-20 14-55-03 (3).txt",
        ] {
            fs::write(dir.join(name), "older").unwrap();
        }
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.txt", "new").unwrap(),
            "2026-10-20 14-55-03 (4).txt"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn when_every_name_up_to_99_is_taken_the_write_is_refused() {
        let dir = scratch("refusal");
        for name in numbered("2026-10-20 14-55-03.txt") {
            fs::write(dir.join(name), "older").unwrap();
        }
        let err = write_new(&dir, "2026-10-20 14-55-03.txt", "new").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 99, "nothing was added");
        assert_eq!(
            fs::read_to_string(dir.join("2026-10-20 14-55-03 (99).txt")).unwrap(),
            "older"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_new_never_overwrites_and_writes_the_text_exactly() {
        let dir = scratch("twice");
        let first = write_new(&dir, "2026-10-20 14-55-03.txt", "first text").unwrap();
        let second = write_new(&dir, "2026-10-20 14-55-03.txt", "second, caf\u{e9}\n").unwrap();
        assert_eq!(first, "2026-10-20 14-55-03.txt");
        assert_eq!(second, "2026-10-20 14-55-03 (2).txt");
        assert_eq!(fs::read(dir.join(&first)).unwrap(), b"first text");
        assert_eq!(
            fs::read(dir.join(&second)).unwrap(),
            "second, caf\u{e9}\n".as_bytes(),
            "UTF-8, no BOM"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_follow_the_page_rule_up_to_99() {
        let names: Vec<String> = numbered("2026-10-20 14-55-03.txt").collect();
        assert_eq!(names.len(), 99);
        assert_eq!(names[0], "2026-10-20 14-55-03.txt");
        assert_eq!(names[1], "2026-10-20 14-55-03 (2).txt");
        assert_eq!(names[98], "2026-10-20 14-55-03 (99).txt");
        assert_eq!(numbered("notes").nth(1).unwrap(), "notes (2)");
        assert_eq!(numbered("a.b.txt").nth(1).unwrap(), "a.b (2).txt");
        assert_eq!(numbered(".sight").nth(1).unwrap(), ".sight (2)");
    }

    #[test]
    fn only_a_moment_is_accepted_as_a_base_name() {
        assert!(is_moment(BASE));
        let refused = [
            "",
            "/",
            "2026-10-20/14-55-03",
            "..",
            "2026-10-20 ../55-03",
            "2026-10-20 14-55-0\0",
            "2026-10-20\n14-55-03",
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-033",
            "2026-10-20 14-55-0",
            "2026-1O-20 14-55-03",
            "abcd-ef-gh ij-kl-mn",
        ];
        for base in refused {
            assert!(!is_moment(base), "{base:?} must be refused");
        }
    }

    #[test]
    fn a_chosen_folder_is_remembered_across_a_restart() {
        let dir = scratch("remember");
        let data = dir.join("data");
        let chosen = dir.join("Build_Test_1"); // does not exist: still remembered
        let shown = Folder::load(Some(data.clone()))
            .remember(chosen.clone())
            .unwrap();
        assert_eq!(shown.name, "Build_Test_1", "the page gets the name only");
        let again = Folder::load(Some(data.clone()));
        assert_eq!(again.lock().unwrap().as_deref(), Some(chosen.as_path()));
        assert_eq!(
            again.shown().unwrap().map(|s| s.name).as_deref(),
            Some("Build_Test_1")
        );
        assert!(
            !data.join("folder.tmp").exists(),
            "the temporary file was renamed"
        );
        fs::write(data.join("folder.txt"), "relative/path").unwrap();
        assert!(
            Folder::load(Some(data)).shown().unwrap().is_none(),
            "a relative path is ignored"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn forgetting_clears_the_folder_in_memory_and_on_disk() {
        let dir = scratch("forget");
        let data = dir.join("data");
        let folder = Folder::load(Some(data.clone()));
        folder.remember(dir.clone()).unwrap();
        folder.forget().unwrap();
        assert!(folder.shown().unwrap().is_none());
        assert!(!data.join("folder.txt").exists());
        assert!(
            Folder::load(Some(data)).shown().unwrap().is_none(),
            "nothing after a restart"
        );
        folder.forget().unwrap(); // forgetting twice is fine
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_the_app_cannot_forget_stays_remembered_and_still_takes_saves() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("forget-fails");
        let data = dir.join("data");
        let folder = Folder::load(Some(data.clone()));
        folder.remember(dir.clone()).unwrap();
        // folder.txt cannot be deleted from a data folder that is read-only.
        fs::set_permissions(&data, fs::Permissions::from_mode(0o555)).unwrap();
        let failed = folder.forget();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed
            .unwrap_err()
            .starts_with("Could not forget the folder"));
        assert!(
            folder.shown().unwrap().is_some(),
            "still remembered in memory"
        );
        assert!(data.join("folder.txt").exists(), "and on disk");
        assert_eq!(
            folder.write(BASE, "text").unwrap(),
            format!("{BASE}.txt"),
            "Save still writes into the folder the page shows"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_needs_a_folder_and_a_moment() {
        let dir = scratch("write");
        let folder = Folder::load(Some(dir.join("data")));
        assert_eq!(
            folder.write(BASE, "text").unwrap_err(),
            "No folder is chosen"
        );
        folder.remember(dir.clone()).unwrap();
        for base in ["notes", "2026-10-20 14-55-03.txt", "../escape"] {
            assert!(
                folder.write(base, "text").is_err(),
                "{base:?} must be refused"
            );
        }
        assert_eq!(
            folder.write(BASE, "the text").unwrap(),
            "2026-10-20 14-55-03.txt"
        );
        assert_eq!(
            folder.write(BASE, "again").unwrap(),
            "2026-10-20 14-55-03 (2).txt"
        );
        assert_eq!(
            fs::read_to_string(dir.join("2026-10-20 14-55-03.txt")).unwrap(),
            "the text"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
