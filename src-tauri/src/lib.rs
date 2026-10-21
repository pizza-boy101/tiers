use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

// Secrets (Anthropic key, GitHub token) live in the OS keychain:
// Keychain on macOS, Credential Manager on Windows.
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "com.nick.tiers.dev";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.nick.tiers";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("TIERS_DATA_DIR") {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(PathBuf::from(dir));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    match name {
        "db.json" | "settings.json" => Ok(data_dir(app)?.join(name)),
        _ => Err(format!("Unknown data file: {name}")),
    }
}

fn read_optional(path: PathBuf) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn read_data(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let text = read_optional(data_file(&app, &name)?)?;
    if text.is_some() || name != "db.json" || cfg!(debug_assertions) {
        return Ok(text);
    }
    // First run after the Electron version (1.0): pick up its tasks, which
    // lived in a "Tiers" folder next to this app's data folder.
    match data_dir(&app)?.parent() {
        Some(parent) => read_optional(parent.join("Tiers").join("db.json")),
        None => Ok(None),
    }
}

// Write to a temp file and rename, so a crash mid-write never corrupts the data.
#[tauri::command]
fn write_data(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = data_file(&app, &name)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn keychain(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_secret(name: String) -> Result<Option<String>, String> {
    match keychain(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_secret(name: String, value: String) -> Result<(), String> {
    keychain(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_secret(name: String) -> Result<(), String> {
    match keychain(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn confirm(app: AppHandle, message: String) -> bool {
    app.dialog()
        .message(message)
        .title("Tiers")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

#[tauri::command]
async fn export_backup(app: AppHandle, contents: String, file_name: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(file_name)
        .blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(path, contents).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

// Debug builds only: run a script in the page and write its result to a file,
// so the app can be tested end to end from the command line.
#[cfg(debug_assertions)]
#[tauri::command]
fn smoke_done(app: AppHandle, result: String) {
    if let Ok(out) = std::env::var("TIERS_SMOKE_OUT") {
        let _ = fs::write(out, result);
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    let builder = builder
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Ok(path) = std::env::var("TIERS_SMOKE_SCRIPT") {
                    if let Ok(script) = fs::read_to_string(path) {
                        let _ = webview.eval(&script);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_data, write_data, data_dir_path, open_data_dir, open_url,
            get_secret, set_secret, delete_secret, confirm, export_backup, import_backup, smoke_done
        ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_data, write_data, data_dir_path, open_data_dir, open_url,
        get_secret, set_secret, delete_secret, confirm, export_backup, import_backup
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Tiers");
}
