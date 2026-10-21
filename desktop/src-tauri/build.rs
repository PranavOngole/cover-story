// Declares the app's own commands. The page may call each one only because
// capabilities/main.json grants its permission (decision D-10); the capability
// grants exactly these four and no core or plugin permission.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_folder",
            "saved_folder",
            "forget_folder",
            "write_text_file",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
