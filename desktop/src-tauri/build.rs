// Declares the app's own commands. Once a command is listed here, the page may
// call it only if capabilities/main.json grants its permission (decision D-10).
// Wave A has no commands, and the capability grants no core or plugin
// permission, so the page can call nothing.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[])),
    )
    .expect("failed to run the Tauri build script");
}
