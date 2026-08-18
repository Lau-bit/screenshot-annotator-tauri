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
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

#[cfg(target_os = "windows")]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(target_os = "windows")]
const DWMWCP_DEFAULT: u32 = 0;
#[cfg(target_os = "windows")]
const DWMWCP_DONOTROUND: u32 = 1;

/// Saved window geometry.
///
/// `x`/`y` are **physical** desktop pixels; `width`/`height` are **logical**.
/// The split is deliberate. Windows' virtual desktop is a single physical
/// coordinate space shared by monitors that may each have a different scale
/// factor, so there is no global "logical" position: dividing a desktop
/// coordinate by whichever monitor the window happened to be on produces a
/// number that means something else on every other monitor. Size is the
/// opposite case — logical keeps the window the same *apparent* size when it
/// reopens on a differently-scaled display.
///
/// `space` marks records written in that layout. Records without it are the
/// older all-logical format and are migrated on read rather than teleporting
/// the window on the first launch after an update.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    space: Option<CoordSpace>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CoordSpace {
    /// x/y are physical desktop pixels (current format).
    Physical,
}

/// A monitor as the restore logic needs to see it: physical rect + its scale.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

/// A resolved, ready-to-apply window rect in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl MonitorRect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }
    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }
    fn center(&self) -> (f64, f64) {
        (
            f64::from(self.x) + f64::from(self.width) / 2.0,
            f64::from(self.y) + f64::from(self.height) / 2.0,
        )
    }
}

/// Overlap in px^2 between a window rect and a monitor.
fn overlap_area(rect: &PhysicalRect, monitor: &MonitorRect) -> i64 {
    let rx2 = i64::from(rect.x) + i64::from(rect.width);
    let ry2 = i64::from(rect.y) + i64::from(rect.height);
    let w = (rx2.min(monitor.right()) - i64::from(rect.x).max(i64::from(monitor.x))).max(0);
    let h = (ry2.min(monitor.bottom()) - i64::from(rect.y).max(i64::from(monitor.y))).max(0);
    w * h
}

/// The monitor a restored window should be considered to live on: the one it
/// overlaps most, falling back to the one nearest its centre when it overlaps
/// nothing (a display was unplugged since the geometry was saved).
fn best_monitor<'a>(monitors: &'a [MonitorRect], rect: &PhysicalRect) -> Option<&'a MonitorRect> {
    if monitors.is_empty() {
        return None;
    }
    let best = monitors
        .iter()
        .max_by_key(|monitor| overlap_area(rect, monitor))?;
    if overlap_area(rect, best) > 0 {
        return Some(best);
    }
    let cx = f64::from(rect.x) + f64::from(rect.width) / 2.0;
    let cy = f64::from(rect.y) + f64::from(rect.height) / 2.0;
    monitors.iter().min_by(|a, b| {
        let d = |m: &MonitorRect| {
            let (mx, my) = m.center();
            (mx - cx).powi(2) + (my - cy).powi(2)
        };
        d(a).total_cmp(&d(b))
    })
}

/// Minimum window area that must stay on a monitor for the window to be
/// grabbable — enough of the title bar to click.
const MIN_VISIBLE_W: i32 = 160;
const MIN_VISIBLE_H: i32 = 40;

/// Nudge a rect back until it is reachable on `monitor`.
///
/// This must NOT clamp coordinates to be positive: a monitor left of the
/// primary legitimately occupies negative desktop coordinates (this machine has
/// one at x = -1920), and a `max(0, ..)` clamp would drag every window off it.
/// Only the *reachability* of the window is enforced, never the sign.
fn clamp_visible(rect: &PhysicalRect, monitor: &MonitorRect) -> PhysicalRect {
    let w = i64::from(rect.width);
    let min_x = i64::from(monitor.x) + i64::from(MIN_VISIBLE_W) - w;
    let max_x = monitor.right() - i64::from(MIN_VISIBLE_W);
    let min_y = i64::from(monitor.y);
    let max_y = monitor.bottom() - i64::from(MIN_VISIBLE_H);

    let clamp = |value: i64, lo: i64, hi: i64| if lo > hi { lo } else { value.clamp(lo, hi) };
    PhysicalRect {
        x: clamp(i64::from(rect.x), min_x, max_x) as i32,
        y: clamp(i64::from(rect.y), min_y, max_y) as i32,
        width: rect.width,
        height: rect.height,
    }
}

/// Turn a saved record into the physical rect to apply.
///
/// `current_scale` is only consulted to migrate a legacy all-logical record.
/// Otherwise every number is derived from the target monitor, so the result
/// does not depend on the window's scale factor having been updated yet — which
/// during `setup()` it has not been.
fn resolve_restore_rect(
    monitors: &[MonitorRect],
    saved: &WindowState,
    current_scale: f64,
) -> Option<PhysicalRect> {
    if saved.width == 0 || saved.height == 0 {
        return None;
    }

    let legacy_scale = if saved.space == Some(CoordSpace::Physical) {
        1.0
    } else {
        // Old format: x/y were logical, divided by whatever scale was in force
        // at save time. Re-multiplying by the current scale reproduces exactly
        // the previous behaviour for one launch; the next save writes physical.
        if current_scale > 0.0 { current_scale } else { 1.0 }
    };
    let want_x = (f64::from(saved.x) * legacy_scale).round() as i32;
    let want_y = (f64::from(saved.y) * legacy_scale).round() as i32;

    // Provisional rect at the target position, sized with the *saved* scale so
    // the monitor lookup has something sane to overlap.
    let probe = PhysicalRect {
        x: want_x,
        y: want_y,
        width: saved.width,
        height: saved.height,
    };
    let Some(monitor) = best_monitor(monitors, &probe) else {
        // No monitor information at all: apply the position as-is.
        return Some(probe);
    };

    // Physical size for the monitor the window is actually landing on.
    let width = (f64::from(saved.width) * monitor.scale).round().max(1.0) as u32;
    let height = (f64::from(saved.height) * monitor.scale).round().max(1.0) as u32;
    Some(clamp_visible(
        &PhysicalRect {
            x: want_x,
            y: want_y,
            width,
            height,
        },
        monitor,
    ))
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

fn current_window_state(window: &WebviewWindow) -> Result<WindowState, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read window scale factor: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    let scale = if scale > 0.0 { scale } else { 1.0 };

    Ok(WindowState {
        // Position stays in the desktop's own (physical) space.
        x: position.x,
        y: position.y,
        // Size is stored scale-independently.
        width: (f64::from(size.width) / scale).round() as u32,
        height: (f64::from(size.height) / scale).round() as u32,
        space: Some(CoordSpace::Physical),
    })
}

fn monitor_rects(window: &WebviewWindow) -> Vec<MonitorRect> {
    window
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| MonitorRect {
                    x: monitor.position().x,
                    y: monitor.position().y,
                    width: monitor.size().width,
                    height: monitor.size().height,
                    scale: monitor.scale_factor(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn set_window_bounds(window: &WebviewWindow, bounds: &WindowState) -> Result<(), String> {
    let current_scale = window.scale_factor().unwrap_or(1.0);
    let monitors = monitor_rects(window);
    let Some(rect) = resolve_restore_rect(&monitors, bounds, current_scale) else {
        return Ok(());
    };

    // Everything is physical, so none of this depends on the window's cached
    // scale factor having caught up with a cross-monitor move yet. Position is
    // still applied twice around the resize because resizing can nudge a window
    // that sits near a monitor edge.
    let place = |label: &str| {
        window
            .set_position(Position::Physical(PhysicalPosition {
                x: rect.x,
                y: rect.y,
            }))
            .map_err(|error| format!("Failed to restore {label} window position: {error}"))
    };

    place("initial")?;
    window
        .set_size(Size::Physical(PhysicalSize {
            width: rect.width,
            height: rect.height,
        }))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;
    place("final")
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
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid image data URL.".to_string())?;
    // A canvas that exceeds the browser's size budget yields the empty data URL
    // "data:,", which decodes to zero bytes perfectly happily. Writing that out
    // produced a 0-byte .png that the UI still reported as saved, so an empty or
    // non-image payload is rejected here as well as in the frontend.
    if !header.starts_with("data:image/") {
        return Err(format!("Not an image data URL: {header}"));
    }
    if payload.is_empty() {
        return Err("Image data URL carries no data.".to_string());
    }
    let bytes = general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("Invalid image data: {error}"))?;
    if bytes.is_empty() {
        return Err("Decoded image is empty.".to_string());
    }
    Ok(bytes)
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
    // A minimized window reports a position of (-32000, -32000) on Windows and a
    // collapsed size; persisting that would strand the window off every monitor
    // on the next launch.
    if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
        return Err("Window is minimized — restore it before saving its shape.".to_string());
    }
    let state = current_window_state(&window)?;
    if state.width == 0 || state.height == 0 {
        return Err("Window has no measurable size right now.".to_string());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The development machine's real layout (`td monitors`), which is exactly
    /// the awkward case: a 100% monitor at negative x beside two 125% ones.
    fn layout() -> Vec<MonitorRect> {
        vec![
            // left — 100%, negative desktop coordinates
            MonitorRect { x: -1920, y: 509, width: 1920, height: 1080, scale: 1.0 },
            // center — primary, 125%
            MonitorRect { x: 0, y: 0, width: 3840, height: 2160, scale: 1.25 },
            // right — 125%, portrait
            MonitorRect { x: 3840, y: 0, width: 1440, height: 2560, scale: 1.25 },
        ]
    }

    fn saved(x: i32, y: i32, width: u32, height: u32) -> WindowState {
        WindowState { x, y, width, height, space: Some(CoordSpace::Physical) }
    }

    #[test]
    fn restores_onto_a_negative_coordinate_monitor_unchanged() {
        // The regression this whole rewrite exists for: a window saved on the
        // 100% monitor at negative x must come back exactly there, even though
        // the window is created on the 125% primary and still reports its
        // scale factor when the restore runs.
        let rect = resolve_restore_rect(&layout(), &saved(-1500, 700, 767, 731), 1.25).unwrap();
        assert_eq!(rect.x, -1500, "negative x must survive the round trip");
        assert_eq!(rect.y, 700);
        // Sized for the 100% monitor it is landing on, not the 125% one it left.
        assert_eq!(rect.width, 767);
        assert_eq!(rect.height, 731);
    }

    #[test]
    fn size_follows_the_target_monitors_scale() {
        // Same logical size, landing on a 125% monitor -> larger in physical px
        // so it looks the same size to the user.
        let rect = resolve_restore_rect(&layout(), &saved(400, 300, 800, 600), 1.0).unwrap();
        assert_eq!(rect.width, 1000);
        assert_eq!(rect.height, 750);
    }

    #[test]
    fn negative_coordinates_are_never_clamped_to_zero() {
        // A naive max(0, ..) off-screen guard would drag this onto the primary.
        for x in [-1920, -1900, -1000, -200] {
            let rect = resolve_restore_rect(&layout(), &saved(x, 600, 600, 500), 1.25).unwrap();
            assert!(rect.x < 0, "x {x} was clamped to {} — left monitor unusable", rect.x);
        }
    }

    #[test]
    fn window_on_a_disconnected_monitor_is_pulled_back_into_view() {
        // Saved far off to the left of every monitor (display unplugged).
        let only_primary = vec![layout()[1]];
        let rect = resolve_restore_rect(&only_primary, &saved(-5000, 700, 800, 600), 1.25).unwrap();
        let monitor = only_primary[0];
        assert!(
            overlap_area(&rect, &monitor) > 0,
            "restored rect {rect:?} does not touch any monitor"
        );
        assert!(rect.x + (rect.width as i32) >= monitor.x + MIN_VISIBLE_W);
    }

    #[test]
    fn a_reachable_window_is_left_where_it_was() {
        let rect = resolve_restore_rect(&layout(), &saved(3900, 120, 700, 900), 1.25).unwrap();
        assert_eq!((rect.x, rect.y), (3900, 120));
    }

    #[test]
    fn legacy_logical_records_are_migrated_not_teleported() {
        // No `space` marker: the old format, where x/y were logical. Reproducing
        // the previous behaviour for one launch beats moving the window on the
        // first start after an update.
        let legacy = WindowState { x: 3449, y: 1026, width: 767, height: 731, space: None };
        let rect = resolve_restore_rect(&layout(), &legacy, 1.25).unwrap();
        assert_eq!(rect.x, 4311); // 3449 * 1.25, as the old code produced
        assert_eq!(rect.y, 1283); // 1026 * 1.25
    }

    #[test]
    fn zero_sized_records_are_ignored() {
        assert!(resolve_restore_rect(&layout(), &saved(0, 0, 0, 600), 1.0).is_none());
        assert!(resolve_restore_rect(&layout(), &saved(0, 0, 800, 0), 1.0).is_none());
    }

    #[test]
    fn best_monitor_prefers_the_one_with_the_most_overlap() {
        let monitors = layout();
        // Straddling left/center but mostly on the left one.
        let rect = PhysicalRect { x: -400, y: 600, width: 500, height: 400 };
        assert_eq!(best_monitor(&monitors, &rect).unwrap().x, -1920);
    }

    #[test]
    fn no_monitor_information_applies_the_saved_position_verbatim() {
        let rect = resolve_restore_rect(&[], &saved(-1500, 700, 767, 731), 1.25).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (-1500, 700, 767, 731));
    }

    // ── data-url guards ──────────────────────────────────────────────────────

    #[test]
    fn empty_canvas_export_is_refused_rather_than_written_as_a_0_byte_png() {
        // "data:," is what an over-budget canvas yields from toDataURL().
        assert!(decode_data_url("data:,").is_err());
        assert!(decode_data_url("data:image/png;base64,").is_err());
    }

    #[test]
    fn non_image_data_urls_are_refused() {
        assert!(decode_data_url("data:text/plain;base64,aGk=").is_err());
        assert!(decode_data_url("no-comma-here").is_err());
    }

    #[test]
    fn a_real_png_data_url_still_decodes() {
        // 1x1 transparent PNG.
        let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let bytes = decode_data_url(url).expect("valid png must decode");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One copy only. Two would share `%APPDATA%\com.slaur.screenshot-annotator`'s
    // settings.json (every setter is a read-modify-write, so the loser's edits
    // vanish) and the same WebView2 profile, where the second process gets no
    // webview at all and lingers windowless. A second launch is treated as
    // "bring the annotator to me", which is the only thing double-clicking it
    // twice can mean. The callback NEVER builds a window — doing that inside the
    // single-instance handler deadlocks the app (see the fleet note on it).
    //
    // The escape hatch exists so a verification instance can run over CDP beside
    // the user's copy (set WEBVIEW2_USER_DATA_FOLDER too, or WebView2 refuses it).
    let mut builder = tauri::Builder::default();
    if std::env::var("SCREENSHOT_ANNOTATOR_MULTI").is_err() {
        // Registered first, so it settles before any other plugin does work.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
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
