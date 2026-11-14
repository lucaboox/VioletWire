//! Compressed-sample source: native TS demux, our queue/start policy, native
//! Media Engine hardware decoders/audio clock. No video readback or FFmpeg.
use std::{
    collections::VecDeque,
    mem::ManuallyDrop,
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Media::MediaFoundation::*,
        System::{Com::StructuredStorage::PROPVARIANT, Com::*, Variant::VT_I8},
    },
    core::{BOOL, BSTR, GUID, HRESULT, IUnknown, Interface, OutRef, Ref, Result, implement},
};

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}
struct Track {
    descriptor: IMFStreamDescriptor,
    events: IMFMediaEventQueue,
    stream: Option<IMFMediaStream>,
    samples: VecDeque<IMFSample>,
    queued_bytes: usize,
    tokens: VecDeque<Option<IUnknown>>,
    selected: bool,
    video: bool,
}
const TIMED_SAMPLE: GUID = GUID::from_u128(0x324d6730_2bf9_44ec_b695_754756d69721);
const MAX_SAMPLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_QUEUE_SAMPLES: usize = 240;
const START_CUSHION: i64 = 11_000_000;
// 0.6 s matched TS's rejected cushion, which stalled repeatedly over a
// minute; 1.0 s keeps room for a large read or a late fragment.
const MP4_START_CUSHION: i64 = 10_000_000;
unsafe fn start_origin(samples: &VecDeque<IMFSample>, cushion: i64) -> Option<i64> {
    unsafe {
        let newest = samples
            .iter()
            .filter_map(|sample| sample.GetSampleTime().ok())
            .max()?;
        let keys = || {
            samples
                .iter()
                .filter(|sample| {
                    sample.GetUINT32(&TIMED_SAMPLE).unwrap_or(0) != 0
                        && sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0
                })
                .filter_map(|sample| sample.GetSampleTime().ok())
        };
        keys()
            .rfind(|time| newest - time >= cushion)
            .or_else(|| keys().next())
    }
}
fn trace(message: &str) {
    if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
        eprintln!("[sample-source] {message}");
    }
}
unsafe fn prepare(sample: &IMFSample, time: i64) -> Result<()> {
    unsafe {
        let timed = sample.GetSampleTime().is_ok();
        sample.SetUINT32(&TIMED_SAMPLE, timed as u32)?;
        if !timed {
            sample.SetSampleTime(time.max(0))?;
        }
    }
    Ok(())
}
/// Assemble native TS H.264 elementary chunks into compressed access units.
/// This transform does not decode or re-encode pixels.
struct Remux(IMFTransform);
impl Remux {
    unsafe fn new(input: &IMFMediaType) -> Result<(Self, IMFMediaType)> {
        unsafe {
            let transform: IMFTransform = CoCreateInstance(
                &GUID::from_u128(0x05a47ebb_8bf0_4cbf_ad2f_3b71d75866f5),
                None,
                CLSCTX_INPROC_SERVER,
            )?;
            transform.SetInputType(0, input, 0)?;
            let output = MFCreateMediaType()?;
            input.CopyAllItems(&output)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            transform.SetOutputType(0, &output, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok((Self(transform), output))
        }
    }
    unsafe fn push(&self, sample: &IMFSample) -> Result<Vec<IMFSample>> {
        unsafe {
            self.0.ProcessInput(0, sample, 0)?;
            let mut samples = Vec::new();
            // Bound a malformed transform's output and retain only compressed data.
            for _ in 0..128 {
                let info = self.0.GetOutputStreamInfo(0)?;
                let provided = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0 {
                    None
                } else {
                    let sample = MFCreateSample()?;
                    let size = info.cbSize.max(1024 * 1024);
                    if size > 16 * 1024 * 1024 {
                        return Err(MF_E_INVALIDMEDIATYPE.into());
                    }
                    sample.AddBuffer(&MFCreateMemoryBuffer(size)?)?;
                    Some(sample)
                };
                let mut output = [MFT_OUTPUT_DATA_BUFFER {
                    pSample: ManuallyDrop::new(provided),
                    ..Default::default()
                }];
                let mut status = 0;
                let result = self.0.ProcessOutput(0, &mut output, &mut status);
                // ProcessOutput may return interfaces even on failure.
                let sample = ManuallyDrop::take(&mut output[0].pSample);
                drop(ManuallyDrop::take(&mut output[0].pEvents));
                match result {
                    Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                    Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                        let media = self.0.GetOutputAvailableType(0, 0)?;
                        self.0.SetOutputType(0, &media, 0)?;
                    }
                    Err(error) => return Err(error),
                    Ok(()) => {
                        if let Some(sample) = sample {
                            samples.push(sample);
                        }
                    }
                }
            }
            Ok(samples)
        }
    }
}
unsafe fn assembled(remux: &Option<Remux>, sample: IMFSample, time: i64) -> Result<Vec<IMFSample>> {
    unsafe {
        let samples = match remux {
            Some(remux) => remux.push(&sample)?,
            None => vec![sample],
        };
        for sample in &samples {
            prepare(sample, time)?;
        }
        Ok(samples)
    }
}
#[derive(Default)]
struct State {
    source: Option<IMFMediaSource>,
    tracks: Vec<Track>,
    presentation: Option<IMFPresentationDescriptor>,
    running: bool,
    origin: Option<i64>,
    base: Option<i64>,
    dispatching: bool,
}
struct Shared {
    cushion: i64,
    state: Mutex<State>,
    events: IMFMediaEventQueue,
    wake: Condvar,
    closed: AtomicBool,
    native: Mutex<Option<IMFMediaSource>>,
    /// The stream's timestamps jumped: a fresh input is needed, not HLS.
    jumped: AtomicBool,
}
// SAFETY: this source/streams are implemented with locked Rust state. The MF
// queues, descriptors and samples used here are free-threaded MF objects, and
// supplied async callbacks/tokens follow Media Foundation's work-queue contract.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}
impl Shared {
    fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let native = lock(&self.native).take();
        trace("shutdown-native");
        if let Some(native) = native {
            unsafe {
                let _ = native.Shutdown();
            }
        }
        trace("shutdown-streams");
        // Shutdown can complete MF callbacks; never hold our state lock while
        // calling queues or releasing stream/source COM references.
        let state = std::mem::take(&mut *lock(&self.state));
        for track in &state.tracks {
            unsafe {
                let _ = track.events.Shutdown();
            }
        }
        unsafe {
            let _ = self.events.Shutdown();
        }
        self.wake.notify_all();
        trace("shutdown-complete");
    }
    fn pump(&self) -> Result<()> {
        {
            let mut state = lock(&self.state);
            if state.dispatching {
                return Ok(());
            }
            state.dispatching = true;
        }
        let mut dispatch = Dispatch {
            shared: self,
            active: true,
        };
        loop {
            let item = {
                let mut state = lock(&self.state);
                if !state.running || self.closed.load(Ordering::Acquire) {
                    state.dispatching = false;
                    dispatch.active = false;
                    return Ok(());
                }
                let origin = state.origin.unwrap_or(0);
                let Some(track) = state.tracks.iter_mut().find(|track| {
                    track.selected && !track.samples.is_empty() && !track.tokens.is_empty()
                }) else {
                    state.dispatching = false;
                    dispatch.active = false;
                    return Ok(());
                };
                let sample = track.samples.pop_front().unwrap();
                track.queued_bytes = track
                    .queued_bytes
                    .saturating_sub(unsafe { sample.GetTotalLength().unwrap_or(0) } as usize);
                (
                    sample,
                    track.tokens.pop_front().unwrap(),
                    track.events.clone(),
                    origin,
                )
            };
            self.wake.notify_all();
            unsafe {
                let (sample, token, queue, origin) = item;
                let time = sample.GetSampleTime()?;
                sample.SetSampleTime(time - origin)?;
                if let Ok(decode) = sample.GetUINT64(&MFSampleExtension_DecodeTimestamp) {
                    sample.SetUINT64(
                        &MFSampleExtension_DecodeTimestamp,
                        (decode as i64 - origin) as u64,
                    )?;
                }
                if let Some(token) = token {
                    sample.SetUnknown(&MFSampleExtension_Token, &token)?;
                }
                queue.QueueEventParamUnk(
                    MEMediaSample.0 as u32,
                    &GUID::zeroed(),
                    HRESULT(0),
                    &sample,
                )?;
            }
        }
    }
}
// Serialise event delivery without holding the state lock across a COM call.
// A synchronous request during QueueEvent is picked up by the active dispatcher.
struct Dispatch<'a> {
    shared: &'a Shared,
    active: bool,
}
impl Drop for Dispatch<'_> {
    fn drop(&mut self) {
        if self.active {
            lock(&self.shared.state).dispatching = false;
        }
    }
}

#[implement(IMFMediaSource)]
struct Source(Arc<Shared>);
#[implement(IMFMediaStream)]
struct Stream {
    shared: Arc<Shared>,
    index: usize,
}
macro_rules! event_methods {
    ($kind:ty, $queue:expr) => {
        impl IMFMediaEventGenerator_Impl for $kind {
            fn GetEvent(
                &self,
                flags: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS,
            ) -> Result<IMFMediaEvent> {
                unsafe { ($queue)(self)?.GetEvent(flags.0 as u32) }
            }
            fn BeginGetEvent(
                &self,
                callback: Ref<'_, IMFAsyncCallback>,
                state: Ref<'_, IUnknown>,
            ) -> Result<()> {
                unsafe { ($queue)(self)?.BeginGetEvent(callback.as_ref(), state.as_ref()) }
            }
            fn EndGetEvent(&self, result: Ref<'_, IMFAsyncResult>) -> Result<IMFMediaEvent> {
                unsafe { ($queue)(self)?.EndGetEvent(result.ok()?) }
            }
            fn QueueEvent(
                &self,
                kind: u32,
                extended: *const GUID,
                status: HRESULT,
                value: *const PROPVARIANT,
            ) -> Result<()> {
                unsafe { ($queue)(self)?.QueueEventParamVar(kind, extended, status, value) }
            }
        }
    };
}
event_methods!(
    Source_Impl,
    |this: &Source_Impl| -> Result<IMFMediaEventQueue> { Ok(this.0.events.clone()) }
);
event_methods!(
    Stream_Impl,
    |this: &Stream_Impl| -> Result<IMFMediaEventQueue> {
        lock(&this.shared.state)
            .tracks
            .get(this.index)
            .map(|track| track.events.clone())
            .ok_or_else(|| MF_E_SHUTDOWN.into())
    }
);

fn started(queue: &IMFMediaEventQueue, kind: MF_EVENT_TYPE) -> Result<()> {
    let mut value = PROPVARIANT::default();
    // SAFETY: VT_I8 selects the hVal arm; scalar values need no clearing.
    unsafe {
        (*value.Anonymous.Anonymous).vt = VT_I8;
        (*value.Anonymous.Anonymous).Anonymous.hVal = 0;
        queue.QueueEventParamVar(kind.0 as u32, &GUID::zeroed(), HRESULT(0), &value)
    }
}
impl IMFMediaSource_Impl for Source_Impl {
    fn GetCharacteristics(&self) -> Result<u32> {
        Ok((MFMEDIASOURCE_IS_LIVE.0 | MFMEDIASOURCE_CAN_PAUSE.0) as u32)
    }
    fn CreatePresentationDescriptor(&self) -> Result<IMFPresentationDescriptor> {
        unsafe {
            lock(&self.0.state)
                .presentation
                .as_ref()
                .ok_or_else(|| windows::core::Error::from(MF_E_SHUTDOWN))?
                .Clone()
        }
    }
    fn Start(
        &self,
        presentation: Ref<'_, IMFPresentationDescriptor>,
        _: *const GUID,
        _: *const PROPVARIANT,
    ) -> Result<()> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(MF_E_SHUTDOWN.into());
        }
        let streams = {
            let mut state = lock(&self.0.state);
            let presentation = presentation.ok()?;
            let mut list = Vec::new();
            for (index, track) in state.tracks.iter_mut().enumerate() {
                let mut selected = BOOL(0);
                let mut descriptor = None;
                unsafe {
                    presentation.GetStreamDescriptorByIndex(
                        index as u32,
                        &mut selected,
                        &mut descriptor,
                    )?;
                }
                track.selected = selected.as_bool();
                if track.selected {
                    list.push((track.stream.clone().unwrap(), track.events.clone()));
                }
            }
            if state.origin.is_none() {
                // Keep a short cushion and retain the preceding IDR for decoder
                // preroll. Negative video times are decoded but never displayed.
                let mut origin = state
                    .tracks
                    .iter()
                    .find(|track| track.video)
                    .and_then(|track| unsafe { start_origin(&track.samples, self.0.cushion) })
                    .unwrap_or(0);
                if let Some(video) = state.tracks.iter().find(|track| track.video) {
                    let newest = video
                        .samples
                        .iter()
                        .filter_map(|sample| unsafe { sample.GetSampleTime().ok() })
                        .max()
                        .unwrap_or(origin);
                    origin = origin.max(newest - self.0.cushion);
                }
                for track in &mut state.tracks {
                    let cutoff = if track.video {
                        track
                            .samples
                            .iter()
                            .filter(|sample| unsafe {
                                sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0
                            })
                            .filter_map(|sample| unsafe { sample.GetSampleTime().ok() })
                            .rfind(|time| *time <= origin)
                            .unwrap_or(0)
                    } else {
                        origin
                    };
                    track.samples.retain(|sample| unsafe {
                        sample.GetUINT32(&TIMED_SAMPLE).unwrap_or(0) == 0
                            || sample.GetSampleTime().is_ok_and(|time| time >= cutoff)
                    });
                    track.queued_bytes = track
                        .samples
                        .iter()
                        .map(|sample| unsafe { sample.GetTotalLength().unwrap_or(0) as usize })
                        .sum();
                }
                state.origin = Some(origin);
                if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                    eprintln!(
                        "[sample-source] start_origin_seconds={:.3}",
                        origin as f64 / 10_000_000.
                    );
                }
            }
            state.running = true;
            list
        };
        for (stream, queue) in streams {
            unsafe {
                self.0.events.QueueEventParamUnk(
                    MENewStream.0 as u32,
                    &GUID::zeroed(),
                    HRESULT(0),
                    &stream,
                )?;
            }
            started(&queue, MEStreamStarted)?;
        }
        started(&self.0.events, MESourceStarted)?;
        self.0.pump()
    }
    fn Stop(&self) -> Result<()> {
        lock(&self.0.state).running = false;
        started(&self.0.events, MESourceStopped)
    }
    fn Pause(&self) -> Result<()> {
        let queues = {
            let mut state = lock(&self.0.state);
            state.running = false;
            state
                .tracks
                .iter()
                .map(|track| track.events.clone())
                .collect::<Vec<_>>()
        };
        for queue in queues {
            started(&queue, MEStreamPaused)?;
        }
        started(&self.0.events, MESourcePaused)
    }
    fn Shutdown(&self) -> Result<()> {
        self.0.shutdown();
        Ok(())
    }
}
impl IMFMediaStream_Impl for Stream_Impl {
    fn GetMediaSource(&self) -> Result<IMFMediaSource> {
        lock(&self.shared.state)
            .source
            .clone()
            .ok_or_else(|| MF_E_SHUTDOWN.into())
    }
    fn GetStreamDescriptor(&self) -> Result<IMFStreamDescriptor> {
        lock(&self.shared.state)
            .tracks
            .get(self.index)
            .map(|track| track.descriptor.clone())
            .ok_or_else(|| MF_E_SHUTDOWN.into())
    }
    fn RequestSample(&self, token: Ref<'_, IUnknown>) -> Result<()> {
        {
            let mut state = lock(&self.shared.state);
            let track = state
                .tracks
                .get_mut(self.index)
                .ok_or_else(|| windows::core::Error::from(MF_E_SHUTDOWN))?;
            if track.tokens.len() >= 128 {
                return Err(MF_E_NOTACCEPTING.into());
            }
            track.tokens.push_back(token.as_ref().cloned());
        }
        self.shared.pump()
    }
}

struct OpenJob {
    mp4: bool,
    bytes: IMFByteStream,
    callback: IMFAsyncCallback,
    state: Option<IUnknown>,
    shared: Arc<Shared>,
}
struct ReadPacket {
    status: HRESULT,
    index: u32,
    flags: u32,
    time: i64,
    sample: Option<IMFSample>,
}
// SAFETY: native compressed samples are free-threaded Media Foundation objects.
unsafe impl Send for ReadPacket {}
#[implement(IMFSourceReaderCallback)]
struct ReadCallback(mpsc::SyncSender<ReadPacket>);
impl IMFSourceReaderCallback_Impl for ReadCallback_Impl {
    fn OnReadSample(
        &self,
        status: HRESULT,
        index: u32,
        flags: u32,
        time: i64,
        sample: Ref<'_, IMFSample>,
    ) -> Result<()> {
        let _ = self.0.try_send(ReadPacket {
            status,
            index,
            flags,
            time,
            sample: sample.as_ref().cloned(),
        });
        Ok(())
    }
    fn OnFlush(&self, _: u32) -> Result<()> {
        Ok(())
    }
    fn OnEvent(&self, _: u32, _: Ref<'_, IMFMediaEvent>) -> Result<()> {
        Ok(())
    }
}
unsafe fn read_next(
    reader: &IMFSourceReader,
    receive: &mpsc::Receiver<ReadPacket>,
    shared: &Shared,
) -> Result<ReadPacket> {
    unsafe {
        reader.ReadSample(
            MF_SOURCE_READER_ANY_STREAM.0 as u32,
            0,
            None,
            None,
            None,
            None,
        )?;
    }
    loop {
        if shared.closed.load(Ordering::Acquire) {
            return Err(MF_E_SHUTDOWN.into());
        }
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(packet) => {
                packet.status.ok()?;
                return Ok(packet);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err(MF_E_SHUTDOWN.into()),
        }
    }
}
// SAFETY: free-threaded MF stream/callback objects, as for the adapter's read jobs.
unsafe impl Send for OpenJob {}
#[implement(IMFMediaEngineExtension)]
struct Extension {
    mp4: bool,
    shared: Arc<Shared>,
    stream: IMFByteStream,
    reader: super::byte_stream::Reader,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}
impl IMFMediaEngineExtension_Impl for Extension_Impl {
    fn CanPlayType(&self, _: BOOL, _: &BSTR) -> Result<MF_MEDIA_ENGINE_CANPLAY> {
        Ok(MF_MEDIA_ENGINE_CANPLAY_PROBABLY)
    }
    fn BeginCreateObject(
        &self,
        _: &BSTR,
        _: Ref<'_, IMFByteStream>,
        kind: MF_OBJECT_TYPE,
        _: OutRef<'_, IUnknown>,
        callback: Ref<'_, IMFAsyncCallback>,
        state: Ref<'_, IUnknown>,
    ) -> Result<()> {
        if kind != MF_OBJECT_MEDIASOURCE {
            return Err(MF_E_UNSUPPORTED_BYTESTREAM_TYPE.into());
        }
        let job = OpenJob {
            mp4: self.mp4,
            bytes: self.stream.clone(),
            callback: callback.ok()?.clone(),
            state: state.as_ref().cloned(),
            shared: self.shared.clone(),
        };
        let mut thread = lock(&self.thread);
        if thread.is_some() {
            return Err(MF_E_INVALIDREQUEST.into());
        }
        *thread = Some(
            std::thread::Builder::new()
                .name("vw-compressed-source".into())
                .spawn(move || run(job))
                .map_err(|_| windows::core::Error::from(MF_E_INVALIDREQUEST))?,
        );
        Ok(())
    }
    fn CancelObjectCreation(&self, _: Ref<'_, IUnknown>) -> Result<()> {
        self.reader.close();
        self.shared.shutdown();
        Ok(())
    }
    fn EndCreateObject(&self, result: Ref<'_, IMFAsyncResult>) -> Result<IUnknown> {
        unsafe {
            let result = result.ok()?;
            result.GetStatus()?;
            result.GetObject()
        }
    }
}

pub struct Input {
    mp4: bool,
    pub extension: IMFMediaEngineExtension,
    shared: Arc<Shared>,
    reader: super::byte_stream::Reader,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}
impl Input {
    /// The input stopped at a timestamp jump; reopening it recovers.
    pub fn jumped(&self) -> bool {
        self.shared.jumped.load(Ordering::Acquire)
    }
    pub fn is_mp4(&self) -> bool {
        self.mp4
    }
    pub fn clock_offset(&self) -> f64 {
        let state = lock(&self.shared.state);
        (state.origin.unwrap_or(0) - state.base.unwrap_or(0)).max(0) as f64 / 10_000_000.
    }
    pub fn new(bytes: &super::byte_stream::Input, mp4: bool) -> Result<Self> {
        let shared = Arc::new(Shared {
            cushion: if mp4 {
                MP4_START_CUSHION
            } else {
                START_CUSHION
            },
            state: Mutex::new(State::default()),
            events: unsafe { MFCreateEventQueue()? },
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            native: Mutex::new(None),
            jumped: AtomicBool::new(false),
        });
        let thread = Arc::new(Mutex::new(None));
        let reader = bytes.reader();
        let extension: IMFMediaEngineExtension = Extension {
            mp4,
            shared: shared.clone(),
            stream: bytes.stream.clone(),
            reader: reader.clone(),
            thread: thread.clone(),
        }
        .into();
        Ok(Self {
            mp4,
            extension,
            shared,
            reader,
            thread,
        })
    }
    pub fn close(&self) {
        trace("close-bytes");
        self.reader.close();
        trace("close-source");
        self.shared.shutdown();
        trace("close-complete");
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        self.close();
        trace("join-worker");
        if let Some(thread) = lock(&self.thread).take() {
            let _ = thread.join();
        }
        trace("join-complete");
    }
}
fn run(job: OpenJob) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut opened = false;
    let mut stage = "resolver";
    let result = (|| -> Result<()> {
        unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 2)?;
            let attributes = attributes.unwrap();
            attributes.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1)?;
            let (send, receive) = mpsc::sync_channel(1);
            let callback: IMFSourceReaderCallback = ReadCallback(send).into();
            attributes.SetUnknown(&MF_SOURCE_READER_ASYNC_CALLBACK, &callback)?;
            let resolver = MFCreateSourceResolver()?;
            let mut kind = MF_OBJECT_INVALID;
            let mut object = None;
            resolver.CreateObjectFromByteStream(
                &job.bytes,
                if job.mp4 {
                    windows::core::w!("violetwire.mp4")
                } else {
                    windows::core::w!("violetwire.ts")
                },
                MF_RESOLUTION_MEDIASOURCE.0 as u32,
                None,
                &mut kind,
                &mut object,
            )?;
            let native: IMFMediaSource = object
                .ok_or_else(|| windows::core::Error::from(MF_E_UNSUPPORTED_BYTESTREAM_TYPE))?
                .cast()?;
            *lock(&job.shared.native) = Some(native.clone());
            if job.shared.closed.load(Ordering::Acquire) {
                let _ = native.Shutdown();
                return Err(MF_E_SHUTDOWN.into());
            }
            stage = "reader";
            let reader = MFCreateSourceReaderFromMediaSource(&native, &attributes)?;
            stage = "types";
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
            let mut indices = Vec::new();
            let mut tracks = Vec::new();
            let mut remuxers = Vec::new();
            for index in 0..8 {
                let Ok(media) = reader.GetNativeMediaType(index, 0) else {
                    break;
                };
                let major = media.GetGUID(&MF_MT_MAJOR_TYPE)?;
                if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                    eprintln!(
                        "[sample-source] stream={index} major={major:?} subtype={:?}",
                        media.GetGUID(&MF_MT_SUBTYPE)?
                    );
                }
                if major != MFMediaType_Video && major != MFMediaType_Audio {
                    continue;
                }
                reader.SetCurrentMediaType(index, None, &media)?;
                reader.SetStreamSelection(index, true)?;
                let (remux, output) = if media.GetGUID(&MF_MT_SUBTYPE)? == MFVideoFormat_H264_ES {
                    let (remux, output) = Remux::new(&media)?;
                    (Some(remux), output)
                } else {
                    (None, media.clone())
                };
                let descriptor =
                    MFCreateStreamDescriptor(tracks.len() as u32, &[Some(output.clone())])?;
                descriptor
                    .GetMediaTypeHandler()?
                    .SetCurrentMediaType(&output)?;
                tracks.push(Track {
                    descriptor,
                    events: MFCreateEventQueue()?,
                    stream: None,
                    samples: VecDeque::new(),
                    queued_bytes: 0,
                    tokens: VecDeque::new(),
                    selected: true,
                    video: major == MFMediaType_Video,
                });
                indices.push(index);
                remuxers.push(remux);
            }
            if tracks.is_empty() {
                return Err(MF_E_INVALIDMEDIATYPE.into());
            }
            let descriptors: Vec<_> = tracks
                .iter()
                .map(|track| Some(track.descriptor.clone()))
                .collect();
            let presentation = MFCreatePresentationDescriptor(Some(&descriptors))?;
            for (index, track) in tracks.iter_mut().enumerate() {
                presentation.SelectStream(index as u32)?;
                track.stream = Some(
                    Stream {
                        shared: job.shared.clone(),
                        index,
                    }
                    .into(),
                );
            }
            stage = "warm-samples";
            let warm_started = Instant::now();
            for _ in 0..512 {
                let ReadPacket {
                    index,
                    flags,
                    time,
                    sample,
                    ..
                } = read_next(&reader, &receive, &job.shared)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Err(MF_E_END_OF_STREAM.into());
                }
                if let Some(sample) = sample
                    && let Some(track) = indices.iter().position(|stream| *stream == index)
                {
                    for sample in assembled(&remuxers[track], sample, time)? {
                        let bytes = sample.GetTotalLength()? as usize;
                        if bytes > MAX_SAMPLE_BYTES
                            || tracks.iter().map(|track| track.queued_bytes).sum::<usize>() + bytes
                                > MAX_QUEUE_BYTES
                        {
                            return Err(MF_E_NOTACCEPTING.into());
                        }
                        tracks[track].queued_bytes += bytes;
                        tracks[track].samples.push_back(sample);
                    }
                }
                let newest_key_ready =
                    tracks
                        .iter()
                        .find(|track| track.video)
                        .is_some_and(|track| {
                            let first = track
                                .samples
                                .front()
                                .and_then(|sample| sample.GetSampleTime().ok())
                                .unwrap_or(0);
                            start_origin(&track.samples, job.shared.cushion)
                                .is_some_and(|origin| origin > first + 5_000_000)
                        });
                if tracks.iter().all(|track| track.samples.len() >= 3)
                    && (newest_key_ready || warm_started.elapsed() >= Duration::from_millis(1250))
                {
                    break;
                }
            }
            let source: IMFMediaSource = Source(job.shared.clone()).into();
            {
                let mut state = lock(&job.shared.state);
                state.tracks = tracks;
                state.base = state
                    .tracks
                    .iter()
                    .find(|track| track.video)
                    .and_then(|track| {
                        track
                            .samples
                            .iter()
                            .find(|sample| sample.GetUINT32(&TIMED_SAMPLE).unwrap_or(0) != 0)
                            .and_then(|sample| {
                                sample
                                    .GetUINT64(&MFSampleExtension_DecodeTimestamp)
                                    .ok()
                                    .map(|time| time as i64)
                                    .or_else(|| sample.GetSampleTime().ok())
                            })
                    });
                state.presentation = Some(presentation);
                state.source = Some(source.clone());
            }
            let response = MFCreateAsyncResult(&source, &job.callback, job.state.as_ref())?;
            MFInvokeCallback(&response)?;
            opened = true;
            // The newest sample time per track, to catch a jump in the
            // stream's timestamps (an encoder restart): Media Engine would
            // wait for, or drop, everything after it without an error.
            let mut newest: Vec<Option<i64>> = vec![None; indices.len()];
            while !job.shared.closed.load(Ordering::Acquire) {
                stage = "samples";
                let ReadPacket {
                    index,
                    flags,
                    time,
                    sample,
                    ..
                } = read_next(&reader, &receive, &job.shared)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Err(MF_E_END_OF_STREAM.into());
                }
                if flags
                    & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32
                        | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED.0 as u32)
                    != 0
                {
                    return Err(MF_E_INVALIDMEDIATYPE.into());
                }
                let Some(sample) = sample else {
                    continue;
                };
                let Some(track) = indices.iter().position(|stream| *stream == index) else {
                    continue;
                };
                for sample in assembled(&remuxers[track], sample, time)? {
                    let bytes = sample.GetTotalLength()? as usize;
                    if bytes > MAX_SAMPLE_BYTES {
                        return Err(MF_E_NOTACCEPTING.into());
                    }
                    if let Ok(time) = sample.GetSampleTime() {
                        if let Some(previous) = newest[track]
                            && (time - previous > 30_000_000 || previous - time > 10_000_000)
                        {
                            trace("timestamp-jump");
                            job.shared.jumped.store(true, Ordering::Release);
                            return Err(MF_E_INVALID_TIMESTAMP.into());
                        }
                        newest[track] = Some(newest[track].map_or(time, |previous| previous.max(time)));
                    }
                    {
                        let mut state = lock(&job.shared.state);
                        while state
                            .tracks
                            .get(track)
                            .is_some_and(|track| track.samples.len() >= MAX_QUEUE_SAMPLES)
                            || state
                                .tracks
                                .iter()
                                .map(|track| track.queued_bytes)
                                .sum::<usize>()
                                + bytes
                                > MAX_QUEUE_BYTES
                        {
                            if job.shared.closed.load(Ordering::Acquire) {
                                break;
                            }
                            state = job
                                .shared
                                .wake
                                .wait(state)
                                .unwrap_or_else(PoisonError::into_inner);
                        }
                        if job.shared.closed.load(Ordering::Acquire) {
                            break;
                        }
                        state.tracks[track].queued_bytes += bytes;
                        state.tracks[track].samples.push_back(sample);
                    }
                    job.shared.pump()?;
                }
            }
            Ok(())
        }
    })();
    trace("worker-ended");
    if let Err(error) = result {
        unsafe {
            if !job.shared.closed.load(Ordering::Acquire) {
                eprintln!(
                    "[sample-source] stage={stage} failed code=0x{:08x}",
                    error.code().0 as u32
                );
                if opened {
                    let _ = job.shared.events.QueueEventParamVar(
                        MEError.0 as u32,
                        &GUID::zeroed(),
                        error.code(),
                        std::ptr::null(),
                    );
                }
            }
            if !opened
                && let Ok(response) = MFCreateAsyncResult(None, &job.callback, job.state.as_ref())
            {
                let _ = response.SetStatus(error.code());
                let _ = MFInvokeCallback(&response);
            }
        }
    }
    unsafe {
        CoUninitialize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Platform;
    impl Platform {
        fn new() -> Self {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
                MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
            }
            Self
        }
    }
    impl Drop for Platform {
        fn drop(&mut self) {
            unsafe {
                MFShutdown().unwrap();
                CoUninitialize();
            }
        }
    }
    #[test]
    fn source_prerolls_video_aligns_audio_delivers_tokens_and_shuts_down() {
        let _platform = Platform::new();
        unsafe {
            let shared = Arc::new(Shared {
                cushion: START_CUSHION,
                state: Mutex::new(State::default()),
                events: MFCreateEventQueue().unwrap(),
                wake: Condvar::new(),
                closed: AtomicBool::new(false),
                native: Mutex::new(None),
                jumped: AtomicBool::new(false),
            });
            let source: IMFMediaSource = Source(shared.clone()).into();
            let mut tracks = Vec::new();
            let mut retained_idr = None;
            for (index, video) in [true, false].into_iter().enumerate() {
                let media = MFCreateMediaType().unwrap();
                media
                    .SetGUID(
                        &MF_MT_MAJOR_TYPE,
                        if video {
                            &MFMediaType_Video
                        } else {
                            &MFMediaType_Audio
                        },
                    )
                    .unwrap();
                media
                    .SetGUID(
                        &MF_MT_SUBTYPE,
                        if video {
                            &MFVideoFormat_H264
                        } else {
                            &MFAudioFormat_AAC
                        },
                    )
                    .unwrap();
                let descriptor =
                    MFCreateStreamDescriptor(index as u32, &[Some(media.clone())]).unwrap();
                descriptor
                    .GetMediaTypeHandler()
                    .unwrap()
                    .SetCurrentMediaType(&media)
                    .unwrap();
                let mut samples = VecDeque::new();
                for frame in 0..36 {
                    let sample = MFCreateSample().unwrap();
                    let buffer = MFCreateMemoryBuffer(4).unwrap();
                    buffer.SetCurrentLength(4).unwrap();
                    sample.AddBuffer(&buffer).unwrap();
                    sample.SetSampleTime(frame * 1_000_000).unwrap();
                    sample
                        .SetUINT32(
                            &MFSampleExtension_CleanPoint,
                            (!video || frame % 20 == 0) as u32,
                        )
                        .unwrap();
                    prepare(&sample, 0).unwrap();
                    if video && frame == 20 {
                        retained_idr = Some(sample.clone());
                    }
                    samples.push_back(sample);
                }
                tracks.push(Track {
                    descriptor,
                    events: MFCreateEventQueue().unwrap(),
                    stream: Some(
                        Stream {
                            shared: shared.clone(),
                            index,
                        }
                        .into(),
                    ),
                    samples,
                    queued_bytes: 36 * 4,
                    tokens: VecDeque::new(),
                    selected: true,
                    video,
                });
            }
            let descriptors: Vec<_> = tracks
                .iter()
                .map(|track| Some(track.descriptor.clone()))
                .collect();
            let presentation = MFCreatePresentationDescriptor(Some(&descriptors)).unwrap();
            presentation.SelectStream(0).unwrap();
            presentation.SelectStream(1).unwrap();
            {
                let mut state = lock(&shared.state);
                state.tracks = tracks;
                state.source = Some(source.clone());
                state.presentation = Some(presentation.clone());
            }
            source
                .Start(&presentation, std::ptr::null(), &PROPVARIANT::default())
                .unwrap();
            let (stream, queue, bytes_before) = {
                let state = lock(&shared.state);
                assert_eq!(state.origin, Some(24_000_000));
                // The IDR at 2.0 s stays for decoding; old audio is discarded.
                assert_eq!(
                    state.tracks[0]
                        .samples
                        .front()
                        .unwrap()
                        .GetSampleTime()
                        .unwrap(),
                    20_000_000
                );
                assert_eq!(
                    state.tracks[1]
                        .samples
                        .front()
                        .unwrap()
                        .GetSampleTime()
                        .unwrap(),
                    24_000_000
                );
                (
                    state.tracks[0].stream.clone().unwrap(),
                    state.tracks[0].events.clone(),
                    state.tracks[0].queued_bytes,
                )
            };
            assert_eq!(stream.GetMediaSource().unwrap(), source);
            assert_eq!(
                queue.GetEvent(0).unwrap().GetType().unwrap(),
                MEStreamStarted.0 as u32
            );
            stream.RequestSample(None).unwrap();
            assert_eq!(
                queue.GetEvent(0).unwrap().GetType().unwrap(),
                MEMediaSample.0 as u32
            );
            assert_eq!(retained_idr.unwrap().GetSampleTime().unwrap(), -4_000_000);
            assert_eq!(lock(&shared.state).tracks[0].queued_bytes, bytes_before - 4);
            let producers: Vec<_> = (0..3)
                .map(|_| {
                    let shared = shared.clone();
                    std::thread::spawn(move || {
                        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
                        for _ in 0..5 {
                            lock(&shared.state).tracks[0].tokens.push_back(None);
                            shared.pump().unwrap();
                            std::thread::yield_now();
                        }
                        CoUninitialize();
                    })
                })
                .collect();
            for producer in producers {
                producer.join().unwrap();
            }
            for frame in 21..36 {
                let event = queue.GetEvent(0).unwrap();
                assert_eq!(event.GetType().unwrap(), MEMediaSample.0 as u32);
                let value = event.GetValue().unwrap();
                assert_eq!(
                    value.Anonymous.Anonymous.vt,
                    windows::Win32::System::Variant::VT_UNKNOWN
                );
                let sample: IMFSample = value
                    .Anonymous
                    .Anonymous
                    .Anonymous
                    .punkVal
                    .as_ref()
                    .unwrap()
                    .cast()
                    .unwrap();
                assert_eq!(
                    sample.GetSampleTime().unwrap(),
                    frame * 1_000_000 - 24_000_000
                );
            }
            source.Shutdown().unwrap();
            source.Shutdown().unwrap();
            assert!(lock(&shared.state).source.is_none());
            assert_eq!(
                stream.RequestSample(None).unwrap_err().code(),
                MF_E_SHUTDOWN
            );
        }
    }
    #[test]
    fn native_remux_assembles_fixture_into_timed_compressed_frames() {
        let _platform = Platform::new();
        unsafe {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/playback/fixtures/cutter.mpegts");
            let url = BSTR::from(path.to_str().unwrap());
            let reader = MFCreateSourceReaderFromURL(&url, None).unwrap();
            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .unwrap();
            let video = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            let native = reader.GetNativeMediaType(video, 0).unwrap();
            assert_eq!(
                native.GetGUID(&MF_MT_SUBTYPE).unwrap(),
                MFVideoFormat_H264_ES
            );
            reader.SetCurrentMediaType(video, None, &native).unwrap();
            reader.SetStreamSelection(video, true).unwrap();
            let (remux, output) = Remux::new(&native).unwrap();
            assert_eq!(output.GetGUID(&MF_MT_SUBTYPE).unwrap(), MFVideoFormat_H264);
            let mut frames = 0;
            let mut keys = 0;
            for _ in 0..1024 {
                let (mut flags, mut sample) = (0, None);
                reader
                    .ReadSample(video, 0, None, Some(&mut flags), None, Some(&mut sample))
                    .unwrap();
                if let Some(sample) = sample {
                    for frame in remux.push(&sample).unwrap() {
                        assert!(frame.GetSampleTime().is_ok());
                        assert!(frame.GetSampleDuration().unwrap() > 0);
                        assert!(frame.GetTotalLength().unwrap() > 0);
                        keys += usize::from(
                            frame.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0,
                        );
                        frames += 1;
                    }
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
            }
            assert!(frames >= 100, "only {frames} complete compressed frames");
            assert_eq!(keys, 1); // The generated fixture has one two-second GOP.
        }
    }
}
