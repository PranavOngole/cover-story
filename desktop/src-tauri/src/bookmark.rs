//! Security-scoped bookmarks: how an app in the macOS App Sandbox gets back
//! into a folder the user chose, after a quit. The sandbox lets the app into a
//! folder only once the user picks it in the system panel; a bookmark made
//! then lets the app in again at a later launch, once the bookmark is resolved
//! and access to it is started (Apple, "Accessing files from the macOS App
//! Sandbox", Persist file access with security-scoped URL bookmarks).
//!
//! The rules around the bookmark (where it is kept, when it is renewed, the
//! order of forgetting) are in folder.rs and tested there with a stand-in for
//! this module. The tests at the end of this file run the system's own
//! bookmarks, which also work outside the sandbox.

use std::path::{Path, PathBuf};

/// Makes and opens bookmarks of folders.
pub trait Bookmarks: Send + Sync {
    /// A security-scoped bookmark of the folder, which must exist.
    fn create(&self, folder: &Path) -> Result<Vec<u8>, String>;
    /// The folder a bookmark points to, with access to it started.
    fn open(&self, bookmark: &[u8]) -> Result<Opened, String>;
    /// The folder's name as the bookmark recorded it, read without opening the
    /// bookmark, so that a folder on a drive that is not plugged in can still
    /// be shown; None when the data is not a bookmark.
    fn name(&self, bookmark: &[u8]) -> Option<String>;
}

/// An opened bookmark.
pub struct Opened {
    /// Where the folder is now: a moved or renamed folder is followed.
    pub path: PathBuf,
    /// A new bookmark to keep in place of the old one when that one is stale
    /// (the folder moved or was renamed), or None.
    pub renewed: Option<Vec<u8>>,
    /// The app's access to the folder.
    pub access: Access,
}

/// Access to a folder outside the sandbox, started when a bookmark is opened
/// and stopped when this is dropped: when the folder is forgotten or replaced,
/// or when the app ends.
pub struct Access(Option<Box<dyn FnOnce() + Send>>);

impl Access {
    /// Access that `stop` ends.
    pub fn new(stop: impl FnOnce() + Send + 'static) -> Self {
        Access(Some(Box::new(stop)))
    }

    /// No access to stop, where none was started.
    pub fn none() -> Self {
        Access(None)
    }

    /// Whether there is access to stop.
    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.0.is_some()
    }
}

impl Drop for Access {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            stop();
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::System;

/// The system's bookmarks, through Foundation's NSURL.
#[cfg(target_os = "macos")]
mod mac {
    use std::path::Path;

    use objc2::rc::autoreleasepool;
    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSArray, NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
        NSURLNameKey, NSURL,
    };

    use super::{Access, Bookmarks, Opened};

    /// Read and write access: the app writes into the folder.
    const CREATE: NSURLBookmarkCreationOptions = NSURLBookmarkCreationOptions::WithSecurityScope;

    /// With the bookmark's security scope, and never a dialog or a mounted
    /// volume: the app connects to nothing by itself, so a folder on a share
    /// that is not connected stays remembered and opens once it is back.
    const OPEN: NSURLBookmarkResolutionOptions = NSURLBookmarkResolutionOptions::WithSecurityScope
        .union(NSURLBookmarkResolutionOptions::WithoutUI)
        .union(NSURLBookmarkResolutionOptions::WithoutMounting);

    pub struct System;

    impl Bookmarks for System {
        fn create(&self, folder: &Path) -> Result<Vec<u8>, String> {
            autoreleasepool(|_| {
                let url = NSURL::from_directory_path(folder).ok_or("the path is not usable")?;
                bookmark(&url)
            })
        }

        fn open(&self, bookmark_data: &[u8]) -> Result<Opened, String> {
            autoreleasepool(|_| {
                let data = NSData::with_bytes(bookmark_data);
                let mut stale = Bool::NO;
                // SAFETY: `stale` is a valid place for the answer.
                let url = unsafe {
                    NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                        &data, OPEN, None, &mut stale,
                    )
                }
                .map_err(|e| e.localizedDescription().to_string())?;
                let path = url.to_file_path().ok_or("the path is not usable")?;
                // SAFETY: an ordinary call on a file URL; it has no conditions.
                let started = unsafe { url.startAccessingSecurityScopedResource() };
                // Apple's steps: a stale bookmark is made again from the
                // resolved URL, once access has started.
                let renewed = if stale.as_bool() {
                    bookmark(&url).ok()
                } else {
                    None
                };
                // Only access that started is stopped, as Apple's documentation
                // of startAccessingSecurityScopedResource asks.
                let access = if started {
                    // SAFETY: as above.
                    Access::new(move || unsafe { url.stopAccessingSecurityScopedResource() })
                } else {
                    Access::none()
                };
                Ok(Opened {
                    path,
                    renewed,
                    access,
                })
            })
        }

        fn name(&self, bookmark_data: &[u8]) -> Option<String> {
            autoreleasepool(|_| {
                let data = NSData::with_bytes(bookmark_data);
                // SAFETY: NSURLNameKey is one of Foundation's constant strings.
                let key = unsafe { NSURLNameKey };
                let values = NSURL::resourceValuesForKeys_fromBookmarkData(
                    &NSArray::from_slice(&[key]),
                    &data,
                )?;
                let name = values.objectForKey(key)?;
                Some(name.downcast_ref::<NSString>()?.to_string())
            })
        }
    }

    /// A security-scoped bookmark of a folder's URL.
    fn bookmark(url: &NSURL) -> Result<Vec<u8>, String> {
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            CREATE, None, None,
        )
        .map(|data| data.to_vec())
        .map_err(|e| e.localizedDescription().to_string())
    }
}

/// Elsewhere (Windows comes later) there is no sandbox to get into, and the
/// bookmark is the folder's path itself.
#[cfg(not(target_os = "macos"))]
pub struct System;

#[cfg(not(target_os = "macos"))]
impl Bookmarks for System {
    fn create(&self, folder: &Path) -> Result<Vec<u8>, String> {
        let path = folder.to_str().ok_or("the path is not UTF-8")?;
        Ok(path.as_bytes().to_vec())
    }

    fn open(&self, bookmark: &[u8]) -> Result<Opened, String> {
        let path = PathBuf::from(std::str::from_utf8(bookmark).map_err(|e| e.to_string())?);
        match path.is_absolute() && path.is_dir() {
            true => Ok(Opened {
                path,
                renewed: None,
                access: Access::none(),
            }),
            false => Err("the folder is not there".to_owned()),
        }
    }

    fn name(&self, bookmark: &[u8]) -> Option<String> {
        let path = Path::new(std::str::from_utf8(bookmark).ok()?);
        let name = path.file_name().filter(|_| path.is_absolute())?;
        Some(name.to_string_lossy().into_owned())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::fs;

    /// A fresh, empty directory for one test.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plain-sight-bookmark-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_systems_bookmark_of_a_folder_opens_outside_the_sandbox_too() {
        let dir = scratch("opens");
        let folder = dir.join("Notes for the test");
        fs::create_dir(&folder).unwrap();
        let bookmark = System.create(&folder).unwrap();
        assert_eq!(&bookmark[..4], b"book", "Foundation's bookmark format");
        assert_eq!(
            System.name(&bookmark).as_deref(),
            Some("Notes for the test")
        );
        let opened = System.open(&bookmark).unwrap();
        assert_eq!(
            opened.path.canonicalize().unwrap(),
            folder.canonicalize().unwrap()
        );
        assert!(opened.renewed.is_none(), "a fresh bookmark is not stale");
        assert!(
            opened.access.is_held(),
            "access starts outside the sandbox too, so it is stopped"
        );
        drop(opened);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_moved_folder_is_followed_and_its_bookmark_renewed() {
        let dir = scratch("moved");
        let folder = dir.join("Notes for the test");
        fs::create_dir(&folder).unwrap();
        let bookmark = System.create(&folder).unwrap();
        let moved = dir.join("Notes, moved");
        fs::rename(&folder, &moved).unwrap();
        let opened = System.open(&bookmark).unwrap();
        assert_eq!(
            opened.path.canonicalize().unwrap(),
            moved.canonicalize().unwrap()
        );
        let renewed = opened.renewed.expect("a moved folder's bookmark is stale");
        let again = System.open(&renewed).unwrap();
        assert!(again.renewed.is_none(), "the renewed bookmark is not stale");
        assert_eq!(System.name(&renewed).as_deref(), Some("Notes, moved"));
        drop((opened.access, again));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_that_is_gone_does_not_open_but_keeps_its_name() {
        let dir = scratch("gone");
        let folder = dir.join("Notes for the test");
        fs::create_dir(&folder).unwrap();
        let bookmark = System.create(&folder).unwrap();
        fs::remove_dir(&folder).unwrap();
        assert!(System.open(&bookmark).is_err());
        assert_eq!(
            System.name(&bookmark).as_deref(),
            Some("Notes for the test")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_plain_path_is_not_a_bookmark_and_a_missing_folder_has_none() {
        let dir = scratch("plain");
        let path = dir.to_str().unwrap().as_bytes();
        assert!(
            System.open(path).is_err(),
            "folder.txt's plain path opens nothing"
        );
        assert_eq!(System.name(path), None);
        assert!(System.create(&dir.join("not there")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
