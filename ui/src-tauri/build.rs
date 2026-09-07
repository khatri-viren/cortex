fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "list_vaults",
        "add_vault_via_dialog",
        "remove_vault",
        "reveal_vault",
        "open_vault",
        "get_preferences",
        "load_session",
        "save_session",
        "set_preferences",
        "close_main_window",
        "save_pdf",
      ]),
    ),
  )
  .expect("failed to build Tauri application manifest");
}
