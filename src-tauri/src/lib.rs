use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
#[cfg(target_os = "windows")]
use clipboard_win::Getter;
use image::DynamicImage;
#[cfg(target_os = "windows")]
use image::{codecs::bmp::BmpDecoder, ImageDecoder};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{borrow::Cow, fs, io::Cursor, path::PathBuf, process::Command};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

#[cfg(target_os = "windows")]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(target_os = "windows")]
const DWMWCP_DEFAULT: u32 = 0;
#[cfg(target_os = "windows")]
const DWMWCP_DONOTROUND: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Map<String, Value> {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<Value>(&data).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Map<String, Value>) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, data).map_err(|error| format!("Failed to save settings: {error}"))
}

fn current_logical_window_state(window: &WebviewWindow) -> Result<WindowState, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read window scale factor: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;

    Ok(WindowState {
        x: (f64::from(position.x) / scale).round() as i32,
        y: (f64::from(position.y) / scale).round() as i32,
        width: (f64::from(size.width) / scale).round() as u32,
        height: (f64::from(size.height) / scale).round() as u32,
    })
}

fn set_window_bounds(window: &WebviewWindow, bounds: &WindowState) -> Result<(), String> {
    if bounds.width == 0 || bounds.height == 0 {
        return Ok(());
    }

    window
        .set_position(Position::Logical(LogicalPosition {
            x: f64::from(bounds.x),
            y: f64::from(bounds.y),
        }))
        .map_err(|error| format!("Failed to restore window position: {error}"))?;
    window
        .set_size(Size::Logical(LogicalSize {
            width: f64::from(bounds.width),
            height: f64::from(bounds.height),
        }))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;
    window
        .set_position(Position::Logical(LogicalPosition {
            x: f64::from(bounds.x),
            y: f64::from(bounds.y),
        }))
        .map_err(|error| format!("Failed to restore final window position: {error}"))
}

fn window_bounds_from_state(state: WindowState) -> WindowBounds {
    WindowBounds {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
    }
}

fn saved_window_state(settings: &Map<String, Value>) -> Option<WindowState> {
    settings
        .get("window")
        .cloned()
        .and_then(|value| serde_json::from_value::<WindowState>(value).ok())
}

fn square_app_corners(settings: &Map<String, Value>) -> bool {
    settings
        .get("squareAppCorners")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn set_square_window_corners(window: &WebviewWindow, square: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to read window handle: {error}"))?;
    let preference = if square {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_DEFAULT
    };
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&preference as *const u32).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("Failed to set window corner preference: {result}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn set_square_window_corners(_window: &WebviewWindow, _square: bool) -> Result<(), String> {
    Ok(())
}

fn png_data_url_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|error| format!("Failed to encode clipboard image: {error}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(png)
    ))
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (_, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid image data URL.".to_string())?;
    general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("Invalid image data: {error}"))
}

fn data_url_from_clipboard_image(image: ImageData<'_>) -> Option<String> {
    let width = u32::try_from(image.width).ok()?;
    let height = u32::try_from(image.height).ok()?;
    png_data_url_from_rgba(width, height, &image.bytes).ok()
}

fn data_url_from_decoded_image(decoded: DynamicImage) -> Option<String> {
    let image = decoded.to_rgba8();
    png_data_url_from_rgba(image.width(), image.height(), &image).ok()
}

#[cfg(target_os = "windows")]
fn data_url_from_dib(dib: Vec<u8>) -> Option<String> {
    let decoder = BmpDecoder::new_without_file_header(Cursor::new(dib)).ok()?;
    let _ = decoder.dimensions();
    data_url_from_decoded_image(DynamicImage::from_decoder(decoder).ok()?)
}

#[cfg(target_os = "windows")]
fn data_url_from_bmp(bmp: Vec<u8>) -> Option<String> {
    let decoded = ImageReader::new(Cursor::new(bmp))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    data_url_from_decoded_image(decoded)
}

#[cfg(target_os = "windows")]
fn read_clipboard_image_windows_fallback() -> Option<String> {
    let _clipboard = clipboard_win::Clipboard::new().ok()?;

    let mut data = Vec::new();

    if clipboard_win::is_format_avail(clipboard_win::formats::CF_DIB)
        && clipboard_win::raw::get_vec(clipboard_win::formats::CF_DIB, &mut data).is_ok()
    {
        if let Some(data_url) = data_url_from_dib(data) {
            return Some(data_url);
        }
    }

    data = Vec::new();
    if clipboard_win::formats::Bitmap
        .read_clipboard(&mut data)
        .is_ok()
    {
        return data_url_from_bmp(data);
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_image_windows_fallback() -> Option<String> {
    None
}

#[tauri::command]
fn read_clipboard_image() -> Option<String> {
    Clipboard::new()
        .ok()
        .and_then(|mut clipboard| clipboard.get_image().ok())
        .and_then(data_url_from_clipboard_image)
        .or_else(read_clipboard_image_windows_fallback)
}

#[tauri::command]
fn read_image_file(file_path: String) -> Option<String> {
    let bytes = fs::read(file_path).ok()?;
    let decoded = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    data_url_from_decoded_image(decoded)
}

#[tauri::command]
fn write_clipboard_image(data_url: String) -> bool {
    let Ok(bytes) = decode_data_url(&data_url) else {
        return false;
    };
    let Ok(decoded) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .and_then(|reader| reader.decode().map_err(std::io::Error::other))
    else {
        return false;
    };

    let image = decoded.to_rgba8();
    let Ok(width) = usize::try_from(image.width()) else {
        return false;
    };
    let Ok(height) = usize::try_from(image.height()) else {
        return false;
    };

    Clipboard::new()
        .and_then(|mut clipboard| {
            clipboard.set_image(ImageData {
                width,
                height,
                bytes: Cow::Owned(image.into_raw()),
            })
        })
        .is_ok()
}

#[tauri::command]
fn save_file(file_path: String, data_url: String) -> bool {
    let Ok(bytes) = decode_data_url(&data_url) else {
        return false;
    };
    let path = PathBuf::from(file_path);
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    fs::write(path, bytes).is_ok()
}

#[tauri::command]
fn ensure_folder(folder_path: String) -> bool {
    fs::create_dir_all(folder_path).is_ok()
}

#[tauri::command]
fn get_default_save_folder(app: AppHandle) -> Option<String> {
    let folder = app.path().app_data_dir().ok()?.join("Saved Screenshots");
    fs::create_dir_all(&folder).ok()?;
    Some(folder.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_folder(folder_path: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(folder_path).spawn().is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(folder_path).spawn().is_ok()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(folder_path).spawn().is_ok()
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Value {
    Value::Object(load_settings(&app))
}

#[tauri::command]
fn set_settings(app: AppHandle, data: Value) -> bool {
    let mut settings = load_settings(&app);
    if let Some(data) = data.as_object() {
        for (key, value) in data {
            settings.insert(key.clone(), value.clone());
        }
    }
    save_settings(&app, &settings).is_ok()
}

#[tauri::command]
fn save_window_shape(app: AppHandle, window: WebviewWindow) -> Result<WindowBounds, String> {
    let state = current_logical_window_state(&window)?;
    let mut settings = load_settings(&app);
    settings.insert(
        "window".to_string(),
        serde_json::to_value(state)
            .map_err(|error| format!("Failed to serialize window state: {error}"))?,
    );
    save_settings(&app, &settings)?;
    Ok(window_bounds_from_state(state))
}

#[tauri::command]
fn set_window_square_corners(window: WebviewWindow, square: bool) -> Result<(), String> {
    set_square_window_corners(&window, square)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let settings = load_settings(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                let _ = set_square_window_corners(&window, square_app_corners(&settings));
                if let Some(bounds) = saved_window_state(&settings) {
                    let _ = set_window_bounds(&window, &bounds);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_folder,
            get_default_save_folder,
            get_settings,
            open_folder,
            read_clipboard_image,
            read_image_file,
            save_file,
            save_window_shape,
            set_settings,
            set_window_square_corners,
            write_clipboard_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
