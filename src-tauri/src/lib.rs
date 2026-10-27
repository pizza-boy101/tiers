use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
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

// ---------- Google sign-in (desktop) ----------
//
// Google doesn't allow signing in inside an app's embedded web view, so the
// app opens the connect page on the website in the user's browser. That page
// signs in with Google and hands the Google ID token back to a one-time
// listener on 127.0.0.1, which checks a random `state` value first.

const CONNECT_BASE: &str = "https://pizza-boy101.github.io/tiers/";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
static SIGN_IN_CANCELLED: AtomicBool = AtomicBool::new(false);

const CALLBACK_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Tiers</title>
<body style="font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;margin:0">
<p id="m">Finishing sign-in…</p>
<script>
fetch("/token", { method: "POST", body: location.hash.slice(1) })
  .then((r) => { document.getElementById("m").textContent = r.ok ? "You're signed in. You can close this tab and go back to Tiers." : "Sign-in didn't match. Try again from the app."; })
  .catch(() => { document.getElementById("m").textContent = "Couldn't reach Tiers. Is the app still open?"; });
history.replaceState(null, "", "/callback");
</script>"#;

fn connect_base() -> String {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("TIERS_CONNECT_BASE") {
        return base;
    }
    CONNECT_BASE.to_string()
}

fn random_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn form_value(body: &str, key: &str) -> Option<String> {
    body.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

// Handles one request. Returns the ID token once the browser delivers it.
fn handle(mut stream: TcpStream, state: &str) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf);
        if let Some(head_end) = text.find("\r\n\r\n") {
            let length = text[..head_end]
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                .unwrap_or(0);
            if buf.len() >= head_end + 4 + length || buf.len() > 64 * 1024 {
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let request_line = text.lines().next().unwrap_or("");
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    if request_line.starts_with("GET /callback") {
        respond(&mut stream, "200 OK", "text/html; charset=utf-8", CALLBACK_PAGE);
    } else if request_line.starts_with("POST /token") {
        if form_value(body, "state").as_deref() == Some(state) {
            if let Some(token) = form_value(body, "id_token").filter(|t| !t.is_empty()) {
                respond(&mut stream, "200 OK", "text/plain", "ok");
                return Some(token);
            }
        }
        respond(&mut stream, "400 Bad Request", "text/plain", "state mismatch");
    } else {
        respond(&mut stream, "404 Not Found", "text/plain", "not found");
    }
    None
}

#[tauri::command]
async fn google_sign_in(app: AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_state()?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    SIGN_IN_CANCELLED.store(false, Ordering::SeqCst);

    let url = format!("{}connect.html?port={port}&state={state}", connect_base());
    // Debug builds: tests can take the URL from a file instead of a browser opening.
    #[cfg(debug_assertions)]
    let opened_for_test = std::env::var("TIERS_CONNECT_URL_FILE").map(|f| fs::write(f, &url).is_ok()).unwrap_or(false);
    #[cfg(not(debug_assertions))]
    let opened_for_test = false;
    if !opened_for_test {
        app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + SIGN_IN_TIMEOUT;
        while Instant::now() < deadline {
            if SIGN_IN_CANCELLED.load(Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(token) = handle(stream, &state) {
                        return Ok(token);
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("Sign-in timed out. Try again.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_google_sign_in() {
    SIGN_IN_CANCELLED.store(true, Ordering::SeqCst);
}

// Debug builds can point at the local Firebase emulators.
#[tauri::command]
fn use_firebase_emulator() -> bool {
    cfg!(debug_assertions) && std::env::var("TIERS_FIREBASE_EMULATOR").is_ok()
}

// Updates are skipped in debug builds.
#[tauri::command]
fn is_debug_build() -> bool {
    cfg!(debug_assertions)
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

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
            get_secret, set_secret, delete_secret, confirm, export_backup, import_backup, is_debug_build, google_sign_in, cancel_google_sign_in,
            use_firebase_emulator, smoke_done
        ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_data, write_data, data_dir_path, open_data_dir, open_url,
        get_secret, set_secret, delete_secret, confirm, export_backup, import_backup, is_debug_build, google_sign_in, cancel_google_sign_in,
        use_firebase_emulator
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Tiers");
}
