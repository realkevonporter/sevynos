mod gpu_presenter;

use gpu_presenter::GpuPresenter;
use serde::Deserialize;
use serde_json::{json, Value};
use smithay_client_toolkit::reexports::calloop::{
    EventLoop, LoopHandle, PostAction, RegistrationToken,
};
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    data_device_manager::{
        data_device::{DataDevice, DataDeviceHandler},
        data_offer::{DataOfferHandler, DragOffer, SelectionOffer},
        data_source::{CopyPasteSource, DataSourceHandler},
        DataDeviceManagerState, WritePipe,
    },
    delegate_compositor, delegate_data_device, delegate_keyboard, delegate_output,
    delegate_pointer, delegate_registry, delegate_seat, delegate_shm, delegate_xdg_shell,
    delegate_xdg_window,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers},
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        xdg::{
            window::{Window, WindowConfigure, WindowDecorations, WindowHandler},
            XdgShell,
        },
        WaylandSurface,
    },
    shm::{
        slot::{Buffer, SlotPool},
        Shm, ShmHandler,
    },
};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufRead, BufReader, Read, Write},
    os::fd::{FromRawFd, OwnedFd},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{
        wl_data_device::WlDataDevice, wl_data_source::WlDataSource, wl_keyboard, wl_output,
        wl_pointer, wl_seat, wl_shm, wl_surface,
    },
    Connection, QueueHandle,
};

const PROTOCOL_VERSION: u64 = 1;
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const FRAME_MAGIC: &[u8; 8] = b"SEVYNFRM";
const FRAME_PROTOCOL_VERSION: u32 = 1;
const FRAME_HEADER_BYTES: usize = 64;
const FRAME_DAMAGE_BYTES: usize = 16;
const MAX_FRAME_TEXT_BYTES: usize = 128;
const MAX_DAMAGE_REGIONS: usize = 64;
const TEXT_MIME_TYPES: [&str; 3] = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"];

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum HostMessage {
    Initialize {
        #[serde(rename = "applicationName")]
        application_name: String,
    },
    Configure {
        width: u32,
        height: u32,
        #[serde(rename = "scaleFactor")]
        scale_factor: f64,
    },
    CapturePointer {
        #[serde(rename = "pointerId")]
        pointer_id: u32,
        captured: bool,
    },
    ClipboardRead {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    ClipboardWrite {
        #[serde(rename = "requestId")]
        request_id: String,
        text: String,
    },
    ShutdownComplete,
}

#[derive(Debug)]
struct ValidatedMessage {
    sequence: u64,
    message: HostMessage,
}

#[derive(Debug)]
enum InboundEvent {
    Control(Result<ValidatedMessage, String>),
    Frame(Result<Frame, String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DamageRegion {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Debug, PartialEq, Eq)]
struct Frame {
    frame_id: u64,
    display_id: String,
    width: u32,
    height: u32,
    trace_id: Option<String>,
    damage: Vec<DamageRegion>,
    rgba: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FrameReceipt {
    frame_id: u64,
    display_id: String,
    trace_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum DrawDecision {
    NotConfigured,
    WaitingForFrameCallback,
    NoFrame,
    SizeMismatch {
        frame_id: u64,
        frame_width: u32,
        frame_height: u32,
        surface_width: u32,
        surface_height: u32,
    },
    Ready(Frame),
}

#[derive(Debug)]
struct SurfaceState {
    configured: bool,
    width: u32,
    height: u32,
    queued_frame: Option<Frame>,
    committed_frame: Option<FrameReceipt>,
}

impl SurfaceState {
    fn new(width: u32, height: u32) -> Self {
        Self {
            configured: false,
            width,
            height,
            queued_frame: None,
            committed_frame: None,
        }
    }

    fn configure(&mut self, width: u32, height: u32) -> bool {
        let resized = self.width != width || self.height != height;
        self.width = width;
        self.height = height;
        self.configured = true;
        resized
    }

    fn queue(&mut self, frame: Frame) {
        self.queued_frame = Some(frame);
    }

    fn next_draw(&mut self) -> DrawDecision {
        if !self.configured {
            return DrawDecision::NotConfigured;
        }
        if self.committed_frame.is_some() {
            return DrawDecision::WaitingForFrameCallback;
        }
        let Some(frame) = self.queued_frame.take() else {
            return DrawDecision::NoFrame;
        };
        if frame.width != self.width || frame.height != self.height {
            return DrawDecision::SizeMismatch {
                frame_id: frame.frame_id,
                frame_width: frame.width,
                frame_height: frame.height,
                surface_width: self.width,
                surface_height: self.height,
            };
        }
        DrawDecision::Ready(frame)
    }

    fn mark_committed(&mut self, frame: &Frame) {
        self.committed_frame = Some(FrameReceipt {
            frame_id: frame.frame_id,
            display_id: frame.display_id.clone(),
            trace_id: frame.trace_id.clone(),
        });
    }

    fn mark_presented(&mut self) -> Option<FrameReceipt> {
        self.committed_frame.take()
    }
}

struct SeatObjects {
    seat: wl_seat::WlSeat,
    data_device: DataDevice,
}

struct Bridge {
    registry_state: RegistryState,
    seat_state: SeatState,
    output_state: OutputState,
    data_device_manager_state: DataDeviceManagerState,
    shm: Shm,
    window: Window,
    gpu_presenter: Option<GpuPresenter>,
    pool: SlotPool,
    buffer: Option<Buffer>,
    buffer_dimensions: Option<(u32, u32)>,
    cursor_surface: wl_surface::WlSurface,
    _cursor_pool: SlotPool,
    _cursor_buffer: Buffer,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    pointer: Option<wl_pointer::WlPointer>,
    keyboard_focus: bool,
    modifiers: Modifiers,
    pointer_position: (f64, f64),
    pointer_buttons: u32,
    surface: SurfaceState,
    sequence: u64,
    last_host_sequence: u64,
    exit: bool,
    seat_objects: Vec<SeatObjects>,
    clipboard_sources: Vec<CopyPasteSource>,
    clipboard_text: String,
    selection_offers: Vec<(SelectionOffer, Vec<u8>, Option<RegistrationToken>)>,
    pending_clipboard_reads: Vec<String>,
    last_input_serial: Option<u32>,
    host_initialized: bool,
    input_devices_announced: bool,
    pointer_input_announced: bool,
    keyboard_input_announced: bool,
    ready_announced: bool,
    first_frame_received: bool,
    first_buffer_attached: bool,
    first_frame_presented: bool,
    busy_buffer_announced: bool,
    receiver: Receiver<InboundEvent>,
    loop_handle: LoopHandle<'static, Bridge>,
    process_started: Instant,
    focus_trace_started: HashMap<String, Instant>,
    focus_trace_counter: u64,
    focus_trace_enabled: bool,
}

fn generate_cursor_pixels() -> [u8; 32 * 32 * 4] {
    let mut pixels = [0u8; 32 * 32 * 4];
    const CURSOR_MAP: [&str; 24] = [
        "X.......................",
        "XX......................",
        "X#X.....................",
        "X##X....................",
        "X###X...................",
        "X####X..................",
        "X#####X.................",
        "X######X................",
        "X#######X...............",
        "X########X..............",
        "X#########X.............",
        "X##########X............",
        "X###########X...........",
        "X######XXXXXX...........",
        "X###X##X................",
        "X##X.X##X...............",
        "X#X..X##X...............",
        "XX....X##X..............",
        "X.....X##X..............",
        ".......X##X.............",
        ".......X##X.............",
        "........XX..............",
        "........................",
        "........................",
    ];

    for (y, row) in CURSOR_MAP.iter().enumerate() {
        for (x, ch) in row.chars().enumerate() {
            let offset = (y * 32 + x) * 4;
            match ch {
                'X' => {
                    pixels[offset] = 10;
                    pixels[offset + 1] = 10;
                    pixels[offset + 2] = 10;
                    pixels[offset + 3] = 255;
                }
                '#' => {
                    pixels[offset] = 255;
                    pixels[offset + 1] = 255;
                    pixels[offset + 2] = 255;
                    pixels[offset + 3] = 255;
                }
                _ => {}
            }
        }
    }
    pixels
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let connection = Connection::connect_to_env()?;
    let (globals, event_queue) = registry_queue_init(&connection)?;
    let queue_handle = event_queue.handle();
    let mut event_loop: EventLoop<Bridge> = EventLoop::try_new()?;
    WaylandSource::new(connection.clone(), event_queue).insert(event_loop.handle())?;
    let compositor = CompositorState::bind(&globals, &queue_handle)?;
    let xdg_shell = XdgShell::bind(&globals, &queue_handle)?;
    let shm = Shm::bind(&globals, &queue_handle)?;
    let data_device_manager_state = DataDeviceManagerState::bind(&globals, &queue_handle)?;
    let surface = compositor.create_surface(&queue_handle);
    let window = xdg_shell.create_window(surface, WindowDecorations::None, &queue_handle);
    window.set_title("SevynOS Genesis");
    window.set_app_id("org.sevynos.genesis");
    window.set_min_size(Some((640, 400)));
    window.set_fullscreen(None);
    window.commit();
    let gpu_presenter = if std::env::var("SEVYN_GRAPHICS_ACCELERATION").as_deref() == Ok("gpu") {
        match GpuPresenter::new(&connection, &window) {
            Ok(presenter) => {
                eprintln!("GENESIS_WAYLAND_GPU_PRESENTER_ACTIVE");
                Some(presenter)
            }
            Err(error) => {
                eprintln!("GENESIS_WAYLAND_GPU_PRESENTER_UNAVAILABLE error={error}");
                None
            }
        }
    } else {
        None
    };
    let pool = SlotPool::new(1280 * 720 * 4, &shm)?;
    let cursor_surface = compositor.create_surface(&queue_handle);
    let mut cursor_pool = SlotPool::new(32 * 32 * 4 * 2, &shm)?;
    let (cursor_buffer, canvas) = cursor_pool
        .create_buffer(32, 32, 32 * 4, wl_shm::Format::Argb8888)
        .map_err(io::Error::other)?;
    let cursor_pixels = generate_cursor_pixels();
    canvas[..cursor_pixels.len()].copy_from_slice(&cursor_pixels);
    cursor_buffer
        .attach_to(&cursor_surface)
        .map_err(io::Error::other)?;
    cursor_surface.damage_buffer(0, 0, 32, 32);
    cursor_surface.commit();
    let process_started = Instant::now();
    let focus_trace_enabled = std::env::var("SEVYN_FOCUS_TRACE").as_deref() == Ok("1");
    if focus_trace_enabled {
        eprintln!("RUST_FOCUS_TRACE_ENABLED");
    }
    let (sender, receiver) = mpsc::channel();
    let control_sender = sender.clone();
    thread::spawn(move || read_stdin(control_sender));
    thread::spawn(move || read_binary_frames(sender, focus_trace_enabled, process_started));
    let mut bridge = Bridge {
        registry_state: RegistryState::new(&globals),
        seat_state: SeatState::new(&globals, &queue_handle),
        output_state: OutputState::new(&globals, &queue_handle),
        data_device_manager_state,
        shm,
        window,
        gpu_presenter,
        pool,
        buffer: None,
        buffer_dimensions: None,
        cursor_surface,
        _cursor_pool: cursor_pool,
        _cursor_buffer: cursor_buffer,
        keyboard: None,
        pointer: None,
        keyboard_focus: false,
        modifiers: Modifiers::default(),
        pointer_position: (0.0, 0.0),
        pointer_buttons: 0,
        surface: SurfaceState::new(1280, 720),
        sequence: 0,
        last_host_sequence: 0,
        exit: false,
        seat_objects: Vec::new(),
        clipboard_sources: Vec::new(),
        clipboard_text: String::new(),
        selection_offers: Vec::new(),
        pending_clipboard_reads: Vec::new(),
        last_input_serial: None,
        host_initialized: false,
        input_devices_announced: false,
        pointer_input_announced: false,
        keyboard_input_announced: false,
        ready_announced: false,
        first_frame_received: false,
        first_buffer_attached: false,
        first_frame_presented: false,
        busy_buffer_announced: false,
        receiver,
        loop_handle: event_loop.handle(),
        process_started,
        focus_trace_started: HashMap::new(),
        focus_trace_counter: 0,
        focus_trace_enabled,
    };
    let _ = bridge.emit(json!({
        "type": "diagnostic",
        "severity": "info",
        "event": "hardware-cursor-active",
        "message": "Native Wayland hardware cursor active."
    }));
    while !bridge.exit {
        event_loop.dispatch(Duration::from_millis(8), &mut bridge)?;
        bridge.drain_messages(&connection, &queue_handle)?;
    }
    Ok(())
}

fn read_stdin(sender: Sender<InboundEvent>) {
    let mut input = io::stdin().lock();
    loop {
        let result = match read_framed_message(&mut input) {
            Ok(Some(line)) => parse_host_message(&line),
            Ok(None) => break,
            Err(error) => {
                let _ = sender.send(InboundEvent::Control(Err(error.to_string())));
                break;
            }
        };
        if sender.send(InboundEvent::Control(result)).is_err() {
            break;
        }
    }
}

fn read_binary_frames(sender: Sender<InboundEvent>, trace_enabled: bool, started: Instant) {
    // SAFETY: the Node parent creates a dedicated inherited pipe at descriptor 3.
    let mut input = unsafe { File::from_raw_fd(3) };
    loop {
        let result = read_binary_frame(&mut input);
        let (frame, receive_duration) = match result {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(error) => {
                let _ = sender.send(InboundEvent::Frame(Err(error)));
                break;
            }
        };
        if trace_enabled {
            if let Some(trace_id) = &frame.trace_id {
                eprintln!(
                    "RUST_FRAME_RECEIVED traceId={trace_id} frameId={} timestampMs={:.3} receiveDurationMs={:.3}",
                    frame.frame_id,
                    monotonic_ms(started),
                    receive_duration.as_secs_f64() * 1000.0,
                );
                eprintln!(
                    "RUST_FRAME_DECODED traceId={trace_id} frameId={} durationMs=0.000 transport=binary-pipe",
                    frame.frame_id,
                );
            }
        }
        if sender.send(InboundEvent::Frame(Ok(frame))).is_err() {
            break;
        }
    }
}

fn read_framed_message<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated IPC message without newline terminator",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if bytes.len().saturating_add(count) > MAX_MESSAGE_BYTES + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "IPC message exceeds the size limit",
            ));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return String::from_utf8(bytes).map(Some).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "IPC message is not UTF-8")
            });
        }
    }
}

fn parse_host_message(line: &str) -> Result<ValidatedMessage, String> {
    if line.len() > MAX_MESSAGE_BYTES {
        return Err("IPC message exceeds the size limit".into());
    }
    let value: Value = serde_json::from_str(line).map_err(|_| "invalid IPC JSON")?;
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("unsupported IPC protocol".into());
    }
    let sequence = value
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or("missing IPC sequence")?;
    let message =
        serde_json::from_value(value).map_err(|error| format!("invalid IPC message: {error}"))?;
    Ok(ValidatedMessage { sequence, message })
}

impl Bridge {
    fn emit(&mut self, message: Value) -> io::Result<()> {
        self.sequence += 1;
        let mut object = message.as_object().cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "message must be an object")
        })?;
        object.insert("protocolVersion".into(), json!(PROTOCOL_VERSION));
        object.insert("sequence".into(), json!(self.sequence));
        let mut output = io::stdout().lock();
        serde_json::to_writer(&mut output, &object)?;
        output.write_all(b"\n")?;
        output.flush()
    }
    fn drain_messages(
        &mut self,
        connection: &Connection,
        queue_handle: &QueueHandle<Self>,
    ) -> io::Result<()> {
        while let Ok(event) = self.receiver.try_recv() {
            let result = match event {
                InboundEvent::Control(result) => result,
                InboundEvent::Frame(result) => {
                    let frame = match result {
                        Ok(frame) => frame,
                        Err(message) => {
                            eprintln!("GENESIS_BINARY_FRAME_REJECTED error={message}");
                            self.emit(json!({
                                "type":"diagnostic",
                                "severity":"error",
                                "event":"host-frame-rejected",
                                "message":message,
                            }))?;
                            continue;
                        }
                    };
                    if !self.first_frame_received {
                        eprintln!(
                            "GENESIS_PRESENT_MESSAGE_RECEIVED frameId={}",
                            frame.frame_id
                        );
                        eprintln!("GENESIS_PRESENT_PIXELS_DECODED bytes={}", frame.rgba.len());
                        self.first_frame_received = true;
                    }
                    let frame_id = frame.frame_id;
                    let width = frame.width;
                    let height = frame.height;
                    self.surface.queue(frame);
                    self.emit(json!({
                        "type":"diagnostic",
                        "severity":"info",
                        "event":"host-frame-received",
                        "message":format!("Received binary frame {frame_id} for {width}x{height}."),
                    }))?;
                    self.draw(connection, queue_handle)?;
                    continue;
                }
            };
            let item = match result {
                Ok(item) => item,
                Err(message) => {
                    eprintln!("GENESIS_IPC_MESSAGE_REJECTED error={message}");
                    self.emit(json!({
                        "type":"diagnostic",
                        "severity":"error",
                        "event":"ipc-message-rejected",
                        "message":message,
                    }))?;
                    continue;
                }
            };
            if item.sequence <= self.last_host_sequence {
                self.emit(json!({
                    "type":"diagnostic",
                    "severity":"error",
                    "event":"ipc-message-rejected",
                    "message":format!("Stale IPC sequence {} after {}.", item.sequence, self.last_host_sequence),
                }))?;
                continue;
            }
            self.last_host_sequence = item.sequence;
            match item.message {
                HostMessage::Initialize { application_name } => {
                    if application_name.trim().is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "empty application name",
                        ));
                    }
                    self.host_initialized = true;
                    self.announce_input_devices()?;
                }
                HostMessage::Configure {
                    width,
                    height,
                    scale_factor,
                } => {
                    if width == 0 || height == 0 || !scale_factor.is_finite() || scale_factor <= 0.0
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid configuration",
                        ));
                    }
                    if self.surface.configured
                        && (self.surface.width != width || self.surface.height != height)
                    {
                        self.emit(json!({
                            "type":"diagnostic",
                            "severity":"warning",
                            "event":"host-display-size-mismatch",
                            "message":format!(
                                "Host acknowledged {}x{}, but the Wayland surface is {}x{}.",
                                width,
                                height,
                                self.surface.width,
                                self.surface.height,
                            ),
                        }))?;
                    }
                    self.emit(json!({
                        "type":"diagnostic",
                        "severity":"info",
                        "event":"host-display-configured",
                        "message":format!(
                            "Host requested display configure to {}x{} @{}.",
                            width,
                            height,
                            scale_factor,
                        ),
                    }))?;
                    self.draw(connection, queue_handle)?;
                }
                HostMessage::CapturePointer {
                    pointer_id,
                    captured,
                } => {
                    let _ = (pointer_id, captured);
                }
                HostMessage::ClipboardRead { request_id } => {
                    if self
                        .selection_offers
                        .iter()
                        .any(|(_, _, token)| token.is_some())
                    {
                        self.pending_clipboard_reads.push(request_id);
                    } else {
                        let text = self.clipboard_text.clone();
                        self.emit(
                            json!({"type":"clipboard-text","requestId":request_id,"text":text}),
                        )?;
                    }
                }
                HostMessage::ClipboardWrite { request_id, text } => {
                    if text.len() > MAX_CLIPBOARD_BYTES {
                        self.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-write-rejected","message":"Clipboard payload exceeded the size limit."}))?;
                        continue;
                    }
                    let Some(serial) = self.last_input_serial else {
                        self.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-write-rejected","message":"Clipboard ownership requires a recent Wayland input serial."}))?;
                        continue;
                    };
                    let Some(data_device) = self.seat_objects.first().map(|seat| &seat.data_device)
                    else {
                        self.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-write-rejected","message":"No Wayland data device is available."}))?;
                        continue;
                    };
                    self.clipboard_text = text;
                    let source = self
                        .data_device_manager_state
                        .create_copy_paste_source(queue_handle, TEXT_MIME_TYPES.to_vec());
                    source.set_selection(data_device, serial);
                    self.clipboard_sources.push(source);
                    self.emit(json!({"type":"clipboard-text","requestId":request_id,"text":""}))?;
                }
                HostMessage::ShutdownComplete => self.exit = true,
            }
        }
        Ok(())
    }

    fn announce_input_devices(&mut self) -> io::Result<()> {
        if !self.host_initialized
            || self.input_devices_announced
            || self.keyboard.is_none()
            || self.pointer.is_none()
        {
            return Ok(());
        }
        self.input_devices_announced = true;
        eprintln!("GENESIS_WAYLAND_INPUT_DEVICES_INITIALIZED");
        self.emit(json!({
            "type":"diagnostic",
            "severity":"info",
            "event":"input-devices-initialized",
            "message":"Wayland pointer and keyboard capabilities are ready."
        }))
    }
    fn draw(
        &mut self,
        connection: &Connection,
        queue_handle: &QueueHandle<Self>,
    ) -> io::Result<()> {
        let frame = match self.surface.next_draw() {
            DrawDecision::NotConfigured
            | DrawDecision::WaitingForFrameCallback
            | DrawDecision::NoFrame => return Ok(()),
            DrawDecision::SizeMismatch {
                frame_id,
                frame_width,
                frame_height,
                surface_width,
                surface_height,
            } => {
                eprintln!(
                    "GENESIS_WAYLAND_FRAME_SIZE_MISMATCH frameId={frame_id} frame={frame_width}x{frame_height} surface={surface_width}x{surface_height}"
                );
                self.emit(json!({
                    "type":"diagnostic",
                    "severity":"warning",
                    "event":"frame-size-mismatch",
                    "message":format!(
                        "Frame {frame_id} size {frame_width}x{frame_height} does not match configured display {surface_width}x{surface_height}."
                    ),
                }))?;
                return Ok(());
            }
            DrawDecision::Ready(frame) => frame,
        };
        let trace_id = frame.trace_id.clone();
        let width = self.surface.width;
        let height = self.surface.height;
        if let Some(presenter) = self.gpu_presenter.as_mut() {
            let commit_started = Instant::now();
            self.window
                .wl_surface()
                .frame(queue_handle, self.window.wl_surface().clone());
            match presenter.present(&frame.rgba, width, height) {
                Ok(()) => {
                    self.surface.mark_committed(&frame);
                    connection.flush().map_err(io::Error::other)?;
                    if self.focus_trace_enabled {
                        if let Some(trace_id) = &trace_id {
                            eprintln!(
                                "RUST_GPU_SURFACE_PRESENTED traceId={trace_id} frameId={} timestampMs={:.3} durationMs={:.3}",
                                frame.frame_id,
                                monotonic_ms(self.process_started),
                                commit_started.elapsed().as_secs_f64() * 1000.0,
                            );
                        }
                    }
                    if !self.first_buffer_attached {
                        self.first_buffer_attached = true;
                        eprintln!("GENESIS_WAYLAND_GPU_FRAME_PRESENTED frameId={}", frame.frame_id);
                    }
                    return Ok(());
                }
                Err(error) => {
                    eprintln!("GENESIS_WAYLAND_GPU_PRESENT_FAILED error={error} fallback=wl_shm");
                    self.gpu_presenter = None;
                }
            }
        }
        let stride = width as i32 * 4;
        let buffer_started = Instant::now();
        if self.buffer_dimensions != Some((width, height)) {
            self.buffer = None;
            self.buffer_dimensions = None;
        }
        if self.buffer.is_none() {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    width as i32,
                    height as i32,
                    stride,
                    wl_shm::Format::Argb8888,
                )
                .map_err(io::Error::other)?;
            self.buffer = Some(buffer);
            self.buffer_dimensions = Some((width, height));
            eprintln!(
                "GENESIS_WAYLAND_BUFFER_CREATED width={width} height={height} stride={stride} format=argb8888"
            );
            eprintln!(
                "WL_BUFFER SIZE width={width} height={height} stride={stride} format=argb8888"
            );
        }
        let buffer = self.buffer.as_mut().expect("buffer was just created");
        let canvas = match self.pool.canvas(buffer) {
            Some(canvas) => canvas,
            None => {
                if !self.busy_buffer_announced {
                    self.busy_buffer_announced = true;
                    eprintln!("GENESIS_WAYLAND_BUFFER_BUSY allocating=additional-buffer");
                }
                let (next, canvas) = self
                    .pool
                    .create_buffer(
                        width as i32,
                        height as i32,
                        stride,
                        wl_shm::Format::Argb8888,
                    )
                    .map_err(io::Error::other)?;
                *buffer = next;
                canvas
            }
        };
        if self.focus_trace_enabled {
            if let Some(trace_id) = &trace_id {
                eprintln!(
                    "RUST_BUFFER_ACQUIRED traceId={trace_id} frameId={} durationMs={:.3}",
                    frame.frame_id,
                    buffer_started.elapsed().as_secs_f64() * 1000.0,
                );
            }
        }
        let copy_started = Instant::now();
        convert_rgba_to_argb8888(&frame.rgba, &mut canvas[..frame.rgba.len()])?;
        if self.focus_trace_enabled {
            if let Some(trace_id) = &trace_id {
                eprintln!(
                    "RUST_BUFFER_COPIED traceId={trace_id} frameId={} durationMs={:.3} bytes={}",
                    frame.frame_id,
                    copy_started.elapsed().as_secs_f64() * 1000.0,
                    frame.rgba.len(),
                );
            }
        }
        let commit_started = Instant::now();
        buffer
            .attach_to(self.window.wl_surface())
            .map_err(io::Error::other)?;
        if !self.first_buffer_attached {
            eprintln!("GENESIS_WAYLAND_BUFFER_ATTACHED frameId={}", frame.frame_id);
        }
        for region in &frame.damage {
            self.window
                .wl_surface()
                .damage_buffer(region.x, region.y, region.width, region.height);
        }
        self.window
            .wl_surface()
            .frame(queue_handle, self.window.wl_surface().clone());
        self.window.commit();
        self.surface.mark_committed(&frame);
        connection.flush().map_err(io::Error::other)?;
        if self.focus_trace_enabled {
            if let Some(trace_id) = &trace_id {
                eprintln!(
                    "RUST_SURFACE_COMMITTED traceId={trace_id} frameId={} timestampMs={:.3} durationMs={:.3}",
                    frame.frame_id,
                    monotonic_ms(self.process_started),
                    commit_started.elapsed().as_secs_f64() * 1000.0,
                );
            }
        }
        if !self.first_buffer_attached {
            self.first_buffer_attached = true;
            eprintln!(
                "GENESIS_WAYLAND_SURFACE_COMMITTED frameId={}",
                frame.frame_id
            );
        }
        Ok(())
    }
    fn emit_key(&mut self, event_type: &str, event: KeyEvent, repeat: bool) {
        let key_name = match event.keysym {
            Keysym::Return => "Enter".to_string(),
            Keysym::BackSpace => "Backspace".to_string(),
            Keysym::Escape => "Escape".to_string(),
            Keysym::Tab => "Tab".to_string(),
            Keysym::Delete => "Delete".to_string(),
            Keysym::Up => "ArrowUp".to_string(),
            Keysym::Down => "ArrowDown".to_string(),
            Keysym::Left => "ArrowLeft".to_string(),
            Keysym::Right => "ArrowRight".to_string(),
            Keysym::Home => "Home".to_string(),
            Keysym::End => "End".to_string(),
            Keysym::Page_Up => "PageUp".to_string(),
            Keysym::Page_Down => "PageDown".to_string(),
            _ => {
                if let Some(utf8) = event.utf8 {
                    if utf8 == "\r" || utf8 == "\n" {
                        "Enter".to_string()
                    } else if utf8 == "\x08" || utf8 == "\x7f" {
                        "Backspace".to_string()
                    } else if utf8 == "\x1b" {
                        "Escape".to_string()
                    } else if utf8 == "\t" {
                        "Tab".to_string()
                    } else {
                        utf8
                    }
                } else {
                    event.keysym.name().unwrap_or_default().to_owned()
                }
            }
        };
        let _ = self.emit(json!({
            "type": "keyboard",
            "event": event_type,
            "key": key_name,
            "code": format!("Keycode{}", event.raw_code),
            "repeat": repeat,
            "shift": self.modifiers.shift,
            "alt": self.modifiers.alt,
            "control": self.modifiers.ctrl,
            "meta": self.modifiers.logo,
            "timestamp": timestamp()
        }));
    }
}

fn read_binary_frame<R: Read>(reader: &mut R) -> Result<Option<(Frame, Duration)>, String> {
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    let first = reader
        .read(&mut header[..1])
        .map_err(|error| format!("binary frame header read failed: {error}"))?;
    if first == 0 {
        return Ok(None);
    }
    let receive_started = Instant::now();
    reader
        .read_exact(&mut header[1..])
        .map_err(|error| format!("truncated binary frame header: {error}"))?;
    if &header[..8] != FRAME_MAGIC
        || u32::from_le_bytes(header[8..12].try_into().unwrap()) != FRAME_PROTOCOL_VERSION
        || u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize != FRAME_HEADER_BYTES
    {
        return Err("invalid binary frame preamble".into());
    }
    let frame_id = u64::from_le_bytes(header[16..24].try_into().unwrap());
    let width = u32::from_le_bytes(header[24..28].try_into().unwrap());
    let height = u32::from_le_bytes(header[28..32].try_into().unwrap());
    let stride = u32::from_le_bytes(header[32..36].try_into().unwrap());
    let format = u32::from_le_bytes(header[36..40].try_into().unwrap());
    let display_bytes = u32::from_le_bytes(header[40..44].try_into().unwrap()) as usize;
    let trace_bytes = u32::from_le_bytes(header[44..48].try_into().unwrap()) as usize;
    let pixel_bytes = u32::from_le_bytes(header[48..52].try_into().unwrap()) as usize;
    let damage_count = u32::from_le_bytes(header[52..56].try_into().unwrap()) as usize;
    let expected = stride
        .checked_mul(height)
        .ok_or("binary frame length overflow")? as usize;
    if frame_id == 0
        || width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || stride != width.checked_mul(4).ok_or("binary frame stride overflow")?
        || format != 1
        || display_bytes == 0
        || display_bytes > MAX_FRAME_TEXT_BYTES
        || trace_bytes > MAX_FRAME_TEXT_BYTES
        || pixel_bytes != expected
        || pixel_bytes > MAX_FRAME_BYTES
        || damage_count == 0
        || damage_count > MAX_DAMAGE_REGIONS
    {
        return Err("invalid binary RGBA frame metadata".into());
    }
    let mut damage_data = vec![0_u8; damage_count * FRAME_DAMAGE_BYTES];
    reader
        .read_exact(&mut damage_data)
        .map_err(|error| format!("truncated binary frame damage metadata: {error}"))?;
    let mut damage = Vec::with_capacity(damage_count);
    for bytes in damage_data.chunks_exact(FRAME_DAMAGE_BYTES) {
        let region = DamageRegion {
            x: i32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            y: i32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            width: i32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            height: i32::from_le_bytes(bytes[12..16].try_into().unwrap()),
        };
        if region.x < 0
            || region.y < 0
            || region.width <= 0
            || region.height <= 0
            || region.x as i64 + region.width as i64 > width as i64
            || region.y as i64 + region.height as i64 > height as i64
        {
            return Err("binary frame damage region is out of bounds".into());
        }
        damage.push(region);
    }
    let mut display = vec![0_u8; display_bytes];
    reader
        .read_exact(&mut display)
        .map_err(|error| format!("truncated binary frame display ID: {error}"))?;
    let display_id = String::from_utf8(display)
        .map_err(|_| "binary frame display ID is not UTF-8".to_owned())?;
    let mut trace = vec![0_u8; trace_bytes];
    reader
        .read_exact(&mut trace)
        .map_err(|error| format!("truncated binary frame trace ID: {error}"))?;
    let trace_id = if trace.is_empty() {
        None
    } else {
        Some(
            String::from_utf8(trace)
                .map_err(|_| "binary frame trace ID is not UTF-8".to_owned())?,
        )
    };
    let mut rgba = vec![0_u8; pixel_bytes];
    reader
        .read_exact(&mut rgba)
        .map_err(|error| format!("truncated binary frame pixels: {error}"))?;
    Ok(Some((
        Frame {
            frame_id,
            display_id,
            width,
            height,
            trace_id,
            damage,
            rgba,
        },
        receive_started.elapsed(),
    )))
}

fn convert_rgba_to_argb8888(rgba: &[u8], argb: &mut [u8]) -> io::Result<()> {
    if rgba.len() != argb.len() || rgba.len() % 4 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "RGBA conversion length mismatch: input={} output={}",
                rgba.len(),
                argb.len()
            ),
        ));
    }
    for (source, destination) in rgba.chunks_exact(4).zip(argb.chunks_exact_mut(4)) {
        destination.copy_from_slice(&[source[2], source[1], source[0], source[3]]);
    }
    Ok(())
}

fn display(id: &str, width: u32, height: u32, scale: f64) -> Value {
    json!({"id":id,"x":0,"y":0,"width":width,"height":height,"pixelWidth":width,"pixelHeight":height,"scaleFactor":scale,"refreshRate":60,"primary":true})
}
fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn monotonic_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

impl CompositorHandler for Bridge {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        factor: i32,
    ) {
        if self.surface.configured && self.ready_announced {
            let _ = self.emit(json!({"type":"display-configured","displays":[display("wayland-toplevel",self.surface.width,self.surface.height,factor.max(1) as f64)]}));
        }
    }
    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
    }
    fn frame(
        &mut self,
        connection: &Connection,
        queue_handle: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: u32,
    ) {
        if let Some(frame) = self.surface.mark_presented() {
            if !self.first_frame_presented {
                self.first_frame_presented = true;
                eprintln!("GENESIS_FRAME_PRESENTED frameId={}", frame.frame_id);
            }
            let mut message = json!({
                "type":"frame-presented",
                "frameId":frame.frame_id,
                "displayId":frame.display_id,
            });
            if let Some(trace_id) = &frame.trace_id {
                message["traceId"] = json!(trace_id);
                if self.focus_trace_enabled {
                    let total = self
                        .focus_trace_started
                        .remove(trace_id)
                        .map(|started| started.elapsed().as_secs_f64() * 1000.0);
                    eprintln!(
                        "FOCUS_TRACE_PRESENTED traceId={trace_id} frameId={} timestampMs={:.3}{}",
                        frame.frame_id,
                        monotonic_ms(self.process_started),
                        total.map_or_else(String::new, |duration| format!(
                            " totalDurationMs={duration:.3}"
                        )),
                    );
                }
            }
            let _ = self.emit(message);
        }
        let _ = self.draw(connection, queue_handle);
    }
    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}
impl WindowHandler for Bridge {
    fn request_close(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &Window) {
        let _ = self.emit(json!({"type":"shutdown-requested","reason":"wayland-close"}));
    }
    fn configure(
        &mut self,
        connection: &Connection,
        queue_handle: &QueueHandle<Self>,
        _: &Window,
        configure: WindowConfigure,
        _: u32,
    ) {
        let width = configure
            .new_size
            .0
            .map(|size| size.get())
            .unwrap_or(self.surface.width);
        let height = configure
            .new_size
            .1
            .map(|size| size.get())
            .unwrap_or(self.surface.height);
        let was_configured = self.surface.configured;
        let resized = self.surface.configure(width, height);
        if resized {
            self.buffer = None;
            self.buffer_dimensions = None;
        }
        if !was_configured || resized {
            let reason = if was_configured { "resize" } else { "initial" };
            eprintln!("GENESIS_WAYLAND_SURFACE_CONFIGURED width={width} height={height}");
            eprintln!("WAYLAND CONFIGURED SIZE width={width} height={height} reason={reason}");
            let _ = self.emit(json!({
                "type":"diagnostic",
                "severity":"info",
                "event":"visible-surface-configured",
                "message":format!("The fullscreen Genesis Wayland surface is configured at {width}x{height}."),
            }));
        }
        let message_type = if self.ready_announced {
            "display-configured"
        } else {
            self.ready_announced = true;
            "ready"
        };
        let _ = self.emit(json!({
            "type":message_type,
            "displays":[display("wayland-toplevel",width,height,1.0)],
        }));
        let _ = self.draw(connection, queue_handle);
    }
}
impl OutputHandler for Bridge {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
}
impl SeatHandler for Bridge {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }
    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
    fn new_capability(
        &mut self,
        _: &Connection,
        queue_handle: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if !self.seat_objects.iter().any(|item| item.seat == seat) {
            self.seat_objects.push(SeatObjects {
                seat: seat.clone(),
                data_device: self
                    .data_device_manager_state
                    .get_data_device(queue_handle, &seat),
            });
        }
        if capability == Capability::Keyboard && self.keyboard.is_none() {
            self.keyboard = self
                .seat_state
                .get_keyboard_with_repeat(
                    queue_handle,
                    &seat,
                    None,
                    self.loop_handle.clone(),
                    Box::new(|state, _, event| state.emit_key("down", event, true)),
                )
                .ok();
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            self.pointer = self.seat_state.get_pointer(queue_handle, &seat).ok();
        }
        let _ = self.announce_input_devices();
    }
    fn remove_capability(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard {
            if let Some(keyboard) = self.keyboard.take() {
                keyboard.release();
            }
        }
        if capability == Capability::Pointer {
            if let Some(pointer) = self.pointer.take() {
                pointer.release();
            }
        }
    }
    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}
impl KeyboardHandler for Bridge {
    fn enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_keyboard::WlKeyboard,
        surface: &wl_surface::WlSurface,
        _: u32,
        _: &[u32],
        _: &[Keysym],
    ) {
        self.keyboard_focus = self.window.wl_surface() == surface;
    }
    fn leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_keyboard::WlKeyboard,
        surface: &wl_surface::WlSurface,
        _: u32,
    ) {
        if self.window.wl_surface() == surface {
            self.keyboard_focus = false;
        }
    }
    fn press_key(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_keyboard::WlKeyboard,
        serial: u32,
        event: KeyEvent,
    ) {
        self.last_input_serial = Some(serial);
        if !self.keyboard_input_announced {
            self.keyboard_input_announced = true;
            let _ = self.emit(json!({"type":"diagnostic","severity":"info","event":"keyboard-input-received","message":"A Wayland keyboard event reached the native bridge."}));
        }
        if self.modifiers.ctrl && self.modifiers.alt {
            let name = event.keysym.name().unwrap_or_default();
            if name.starts_with('F') && name[1..].chars().all(|c| c.is_ascii_digit()) {
                // Inhibit Linux VT console switching (Ctrl+Alt+Fx) in SevynOS appliance mode
                return;
            }
        }
        if self.keyboard_focus {
            self.emit_key("down", event, false);
        }
    }
    fn release_key(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_keyboard::WlKeyboard,
        _: u32,
        event: KeyEvent,
    ) {
        if self.modifiers.ctrl && self.modifiers.alt {
            let name = event.keysym.name().unwrap_or_default();
            if name.starts_with('F') && name[1..].chars().all(|c| c.is_ascii_digit()) {
                return;
            }
        }
        if self.keyboard_focus {
            self.emit_key("up", event, false);
        }
    }
    fn update_modifiers(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_keyboard::WlKeyboard,
        _: u32,
        modifiers: Modifiers,
        _: u32,
    ) {
        self.modifiers = modifiers;
    }
}
impl PointerHandler for Bridge {
    fn pointer_frame(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            if &event.surface != self.window.wl_surface() {
                continue;
            }
            self.pointer_position = event.position;
            let (kind, button, trace_id) = match event.kind {
                PointerEventKind::Enter { serial } => {
                    self.last_input_serial = Some(serial);
                    pointer.set_cursor(serial, Some(&self.cursor_surface), 0, 0);
                    if !self.pointer_input_announced {
                        self.pointer_input_announced = true;
                        let _ = self.emit(json!({"type":"diagnostic","severity":"info","event":"pointer-input-received","message":"A Wayland pointer event reached the native bridge."}));
                    }
                    (Some("move"), 0, None)
                }
                PointerEventKind::Motion { .. } => {
                    if let Some(serial) = self.last_input_serial {
                        pointer.set_cursor(serial, Some(&self.cursor_surface), 0, 0);
                    }
                    if !self.pointer_input_announced {
                        self.pointer_input_announced = true;
                        let _ = self.emit(json!({"type":"diagnostic","severity":"info","event":"pointer-input-received","message":"A Wayland pointer event reached the native bridge."}));
                    }
                    (Some("move"), 0, None)
                }
                PointerEventKind::Leave { .. } => (Some("cancel"), 0, None),
                PointerEventKind::Press { button, serial, .. } => {
                    self.last_input_serial = Some(serial);
                    self.pointer_buttons |= button_mask(button);
                    let trace_id = if self.focus_trace_enabled {
                        self.focus_trace_counter += 1;
                        let trace_id = format!("focus-{}", self.focus_trace_counter);
                        self.focus_trace_started
                            .insert(trace_id.clone(), Instant::now());
                        eprintln!(
                            "FOCUS_TRACE_START traceId={trace_id} timestampMs={:.3}",
                            monotonic_ms(self.process_started)
                        );
                        eprintln!(
                            "RUST_POINTER_EVENT_RECEIVED traceId={trace_id} timestampMs={:.3}",
                            monotonic_ms(self.process_started)
                        );
                        Some(trace_id)
                    } else {
                        None
                    };
                    (Some("down"), browser_button(button), trace_id)
                }
                PointerEventKind::Release { button, .. } => {
                    self.pointer_buttons &= !button_mask(button);
                    (Some("up"), browser_button(button), None)
                }
                PointerEventKind::Axis {
                    horizontal,
                    vertical,
                    ..
                } => {
                    let dx = if horizontal.absolute != 0.0 {
                        horizontal.absolute
                    } else {
                        horizontal.discrete as f64 * 15.0
                    };
                    let dy = if vertical.absolute != 0.0 {
                        vertical.absolute
                    } else {
                        vertical.discrete as f64 * 15.0
                    };
                    let message = json!({
                        "type": "wheel",
                        "x": event.position.0,
                        "y": event.position.1,
                        "deltaX": dx,
                        "deltaY": dy,
                        "timestamp": timestamp(),
                    });
                    let _ = self.emit(message);
                    (None, 0, None)
                }
            };
            if let Some(kind) = kind {
                let mut message = json!({"type":"pointer","event":kind,"pointerId":1,"x":event.position.0,"y":event.position.1,"button":button,"buttons":self.pointer_buttons,"timestamp":timestamp()});
                if let Some(trace_id) = &trace_id {
                    message["traceId"] = json!(trace_id);
                }
                if self.emit(message).is_ok() {
                    if let Some(trace_id) = &trace_id {
                        eprintln!(
                            "RUST_POINTER_EVENT_SENT traceId={trace_id} timestampMs={:.3}",
                            monotonic_ms(self.process_started)
                        );
                    }
                }
            }
        }
    }
}

impl DataDeviceHandler for Bridge {
    fn enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataDevice,
        _: f64,
        _: f64,
        _: &wl_surface::WlSurface,
    ) {
    }

    fn leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice) {}

    fn motion(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice, _: f64, _: f64) {}

    fn selection(&mut self, _: &Connection, _: &QueueHandle<Self>, device: &WlDataDevice) {
        let Some(data_device) = self
            .seat_objects
            .iter()
            .find(|seat| seat.data_device.inner() == device)
            .map(|seat| &seat.data_device)
        else {
            return;
        };
        let Some(offer) = data_device.data().selection_offer() else {
            self.clipboard_text.clear();
            return;
        };
        let Some(mime) = offer.with_mime_types(|mimes| {
            TEXT_MIME_TYPES.iter().find_map(|supported| {
                mimes
                    .iter()
                    .find(|mime| mime.as_str() == *supported)
                    .cloned()
            })
        }) else {
            let _ = self.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-mime-rejected","message":"The Wayland selection did not offer a supported text MIME type."}));
            return;
        };
        let Ok(read_pipe) = offer.receive(mime) else {
            let _ = self.emit(json!({"type":"diagnostic","severity":"error","event":"clipboard-receive-failed","message":"The Wayland selection could not be opened."}));
            return;
        };
        self.selection_offers
            .push((offer.clone(), Vec::new(), None));
        let tracked_offer = offer.clone();
        if let Ok(token) = self.loop_handle.insert_source(read_pipe, move |_, file, state| {
            let Some(index) = state
                .selection_offers
                .iter()
                .position(|item| item.0 == tracked_offer)
            else {
                return PostAction::Remove;
            };
            let (_, bytes, _) = &mut state.selection_offers[index];
            let file: &mut File = unsafe { file.get_mut() };
            let mut reader = BufReader::new(file);
            let mut chunk = [0_u8; 8192];
            match reader.read(&mut chunk) {
                Ok(0) => {
                    let (_, data, _) = state.selection_offers.remove(index);
                    if data.len() <= MAX_CLIPBOARD_BYTES {
                        if let Ok(text) = String::from_utf8(data) {
                            state.clipboard_text = text;
                            let pending = std::mem::take(&mut state.pending_clipboard_reads);
                            for request_id in pending {
                                let text = state.clipboard_text.clone();
                                let _ = state.emit(json!({"type":"clipboard-text","requestId":request_id,"text":text}));
                            }
                        }
                    } else {
                        let _ = state.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-read-rejected","message":"Clipboard payload exceeded the size limit."}));
                    }
                    PostAction::Remove
                }
                Ok(count) => {
                    if bytes.len().saturating_add(count) > MAX_CLIPBOARD_BYTES {
                        state.selection_offers.remove(index);
                        let _ = state.emit(json!({"type":"diagnostic","severity":"warning","event":"clipboard-read-rejected","message":"Clipboard payload exceeded the size limit."}));
                        PostAction::Remove
                    } else {
                        bytes.extend_from_slice(&chunk[..count]);
                        PostAction::Continue
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => PostAction::Continue,
                Err(_) => {
                    state.selection_offers.remove(index);
                    let _ = state.emit(json!({"type":"diagnostic","severity":"error","event":"clipboard-read-failed","message":"Reading the Wayland clipboard failed."}));
                    PostAction::Remove
                }
            }
        }) {
            if let Some(item) = self.selection_offers.last_mut() {
                item.2 = Some(token);
            }
        }
    }

    fn drop_performed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice) {}
}

impl DataOfferHandler for Bridge {
    fn source_actions(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &mut DragOffer,
        _: wayland_client::protocol::wl_data_device_manager::DndAction,
    ) {
    }

    fn selected_action(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &mut DragOffer,
        _: wayland_client::protocol::wl_data_device_manager::DndAction,
    ) {
    }
}

impl DataSourceHandler for Bridge {
    fn accept_mime(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataSource,
        _: Option<String>,
    ) {
    }

    fn send_request(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        source: &WlDataSource,
        mime: String,
        pipe: WritePipe,
    ) {
        if !TEXT_MIME_TYPES.contains(&mime.as_str())
            || !self
                .clipboard_sources
                .iter()
                .any(|candidate| candidate.inner() == source)
        {
            return;
        }
        let mut file = File::from(OwnedFd::from(pipe));
        let _ = file.write_all(self.clipboard_text.as_bytes());
    }

    fn cancelled(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &WlDataSource) {
        self.clipboard_sources
            .retain(|candidate| candidate.inner() != source);
        source.destroy();
    }

    fn dnd_dropped(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataSource) {}
    fn dnd_finished(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataSource) {}
    fn action(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataSource,
        _: wayland_client::protocol::wl_data_device_manager::DndAction,
    ) {
    }
}
fn browser_button(button: u32) -> u32 {
    match button {
        0x110 => 0,
        0x112 => 1,
        0x111 => 2,
        _ => 0,
    }
}
fn button_mask(button: u32) -> u32 {
    match button {
        0x110 => 1,
        0x111 => 2,
        0x112 => 4,
        _ => 0,
    }
}
impl ShmHandler for Bridge {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}
delegate_compositor!(Bridge);
delegate_output!(Bridge);
delegate_shm!(Bridge);
delegate_seat!(Bridge);
delegate_keyboard!(Bridge);
delegate_pointer!(Bridge);
delegate_data_device!(Bridge);
delegate_xdg_shell!(Bridge);
delegate_xdg_window!(Bridge);
delegate_registry!(Bridge);
impl ProvidesRegistryState for Bridge {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState,];
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn frame(frame_id: u64, width: u32, height: u32) -> Frame {
        Frame {
            frame_id,
            display_id: "display-1".into(),
            width,
            height,
            trace_id: None,
            damage: vec![DamageRegion {
                x: 0,
                y: 0,
                width: width as i32,
                height: height as i32,
            }],
            rgba: vec![0xff; width as usize * height as usize * 4],
        }
    }

    fn binary_packet(frame: &Frame) -> Vec<u8> {
        let display = frame.display_id.as_bytes();
        let trace = frame.trace_id.as_deref().unwrap_or_default().as_bytes();
        let mut bytes = vec![0_u8; FRAME_HEADER_BYTES];
        bytes[..8].copy_from_slice(FRAME_MAGIC);
        bytes[8..12].copy_from_slice(&FRAME_PROTOCOL_VERSION.to_le_bytes());
        bytes[12..16].copy_from_slice(&(FRAME_HEADER_BYTES as u32).to_le_bytes());
        bytes[16..24].copy_from_slice(&frame.frame_id.to_le_bytes());
        bytes[24..28].copy_from_slice(&frame.width.to_le_bytes());
        bytes[28..32].copy_from_slice(&frame.height.to_le_bytes());
        bytes[32..36].copy_from_slice(&(frame.width * 4).to_le_bytes());
        bytes[36..40].copy_from_slice(&1_u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&(display.len() as u32).to_le_bytes());
        bytes[44..48].copy_from_slice(&(trace.len() as u32).to_le_bytes());
        bytes[48..52].copy_from_slice(&(frame.rgba.len() as u32).to_le_bytes());
        bytes[52..56].copy_from_slice(&(frame.damage.len() as u32).to_le_bytes());
        for region in &frame.damage {
            bytes.extend_from_slice(&region.x.to_le_bytes());
            bytes.extend_from_slice(&region.y.to_le_bytes());
            bytes.extend_from_slice(&region.width.to_le_bytes());
            bytes.extend_from_slice(&region.height.to_le_bytes());
        }
        bytes.extend_from_slice(display);
        bytes.extend_from_slice(trace);
        bytes.extend_from_slice(&frame.rgba);
        bytes
    }

    #[test]
    fn validates_exact_binary_rgba_frames() {
        let expected = frame(1, 2, 2);
        let packet = binary_packet(&expected);
        assert_eq!(
            read_binary_frame(&mut Cursor::new(packet))
                .unwrap()
                .map(|(frame, _)| frame),
            Some(expected)
        );
        let mut invalid_stride = binary_packet(&frame(1, 2, 2));
        invalid_stride[32..36].copy_from_slice(&7_u32.to_le_bytes());
        assert!(read_binary_frame(&mut Cursor::new(invalid_stride)).is_err());
        let mut truncated = binary_packet(&frame(1, 2, 2));
        truncated.pop();
        assert!(read_binary_frame(&mut Cursor::new(truncated)).is_err());
    }

    #[test]
    fn converts_rgba_test_pattern_to_little_endian_argb8888() {
        // top-left red, top-right green, bottom-left blue, bottom-right white
        let rgba = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let mut argb = [0_u8; 16];
        convert_rgba_to_argb8888(&rgba, &mut argb).unwrap();
        assert_eq!(
            argb,
            [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,]
        );
    }

    #[test]
    fn requires_configure_before_first_buffer_and_recreates_after_resize() {
        let mut surface = SurfaceState::new(1280, 720);
        surface.queue(frame(1, 1280, 720));
        assert_eq!(surface.next_draw(), DrawDecision::NotConfigured);
        assert!(!surface.configure(1280, 720));
        assert!(matches!(surface.next_draw(), DrawDecision::Ready(_)));
        assert!(surface.configure(1024, 768));
        surface.queue(frame(2, 1280, 720));
        assert!(matches!(
            surface.next_draw(),
            DrawDecision::SizeMismatch {
                frame_id: 2,
                surface_width: 1024,
                surface_height: 768,
                ..
            }
        ));
        surface.queue(frame(3, 1024, 768));
        assert!(matches!(surface.next_draw(), DrawDecision::Ready(_)));
    }

    #[test]
    fn queues_while_a_wayland_buffer_is_in_flight_and_acknowledges_on_callback() {
        let mut surface = SurfaceState::new(2, 2);
        surface.configure(2, 2);
        surface.queue(frame(1, 2, 2));
        let first = match surface.next_draw() {
            DrawDecision::Ready(frame) => frame,
            decision => panic!("unexpected decision: {decision:?}"),
        };
        surface.mark_committed(&first);
        surface.queue(frame(2, 2, 2));
        surface.queue(frame(3, 2, 2));
        assert_eq!(surface.next_draw(), DrawDecision::WaitingForFrameCallback);
        assert_eq!(
            surface.mark_presented(),
            Some(FrameReceipt {
                frame_id: 1,
                display_id: "display-1".into(),
                trace_id: None,
            })
        );
        assert!(matches!(surface.next_draw(), DrawDecision::Ready(frame) if frame.frame_id == 3));
    }

    #[test]
    fn reads_a_complete_1280x720_binary_frame_across_small_partial_reads() {
        let expected = frame(9, 1280, 720);
        let packet = binary_packet(&expected);
        let mut reader = BufReader::with_capacity(17, Cursor::new(packet));
        assert_eq!(
            read_binary_frame(&mut reader)
                .unwrap()
                .map(|(frame, _)| frame),
            Some(expected)
        );
        assert!(read_binary_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_truncated_ndjson_messages() {
        let mut reader =
            BufReader::with_capacity(3, Cursor::new("{\"protocolVersion\":1,\"sequence\":1"));
        assert_eq!(
            read_framed_message(&mut reader).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[test]
    fn rejects_protocol_mismatch() {
        assert!(parse_host_message(
            "{\"protocolVersion\":2,\"sequence\":1,\"type\":\"shutdown-complete\"}"
        )
        .is_err());
    }
}
