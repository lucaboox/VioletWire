//! The volume normaliser: a dynamics compressor inserted into Windows Media
//! Engine's audio path as a Media Foundation transform.
//!
//! It matches the Electron player's WebAudio `DynamicsCompressorNode`
//! (threshold −18 dB, 12 dB knee, 4:1, 20 ms attack, 250 ms release) including
//! WebAudio's automatic make-up gain, so quiet voices come up and loud moments
//! come down the same way in both clients. The effect is always inserted (Media
//! Engine only accepts effects before a source loads) and bypasses itself while
//! switched off, so toggling never interrupts playback.

use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicBool, Ordering},
};

use windows::{
    Win32::{Foundation::E_NOTIMPL, Media::MediaFoundation::*},
    core::{Ref, Result, implement},
};

const THRESHOLD_DB: f32 = -18.0;
const KNEE_DB: f32 = 12.0;
const RATIO: f32 = 4.0;
const ATTACK_SECONDS: f32 = 0.02;
const RELEASE_SECONDS: f32 = 0.25;

/// Shared between the player (which flips it) and the audio thread.
#[derive(Clone, Default)]
pub struct Switch {
    enabled: Arc<AtomicBool>,
    /// Set once Media Engine has actually routed audio through the effect.
    active: Arc<AtomicBool>,
}

impl Switch {
    pub fn set(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

/// The static curve: output level for an input level, both in dBFS, with a
/// quadratic soft knee centred on the threshold.
fn curve(level: f32) -> f32 {
    let over = level - THRESHOLD_DB;
    if 2.0 * over < -KNEE_DB {
        level
    } else if 2.0 * over.abs() <= KNEE_DB {
        let into = over + KNEE_DB / 2.0;
        level + (1.0 / RATIO - 1.0) * into * into / (2.0 * KNEE_DB)
    } else {
        THRESHOLD_DB + over / RATIO
    }
}

/// WebAudio's make-up gain: (1 / gain at full scale)^0.6, about +8.1 dB here.
fn makeup_db() -> f32 {
    -curve(0.0) * 0.6
}

struct Dsp {
    sample_rate: f32,
    channels: usize,
    /// Smoothed gain reduction in dB (≤ 0).
    reduction: f32,
}

impl Dsp {
    fn process(&mut self, samples: &mut [f32]) {
        if self.channels == 0 || self.sample_rate <= 0.0 {
            return;
        }
        let attack = (-1.0 / (ATTACK_SECONDS * self.sample_rate)).exp();
        let release = (-1.0 / (RELEASE_SECONDS * self.sample_rate)).exp();
        let makeup = makeup_db();
        for frame in samples.chunks_exact_mut(self.channels) {
            let peak = frame.iter().fold(0.0f32, |peak, sample| peak.max(sample.abs()));
            let level = 20.0 * peak.max(1e-6).log10();
            let target = curve(level) - level;
            let coefficient = if target < self.reduction { attack } else { release };
            self.reduction = coefficient * self.reduction + (1.0 - coefficient) * target;
            let gain = 10f32.powf((self.reduction + makeup) / 20.0);
            for sample in frame {
                // Make-up gain can push a transient past full scale before the
                // envelope catches it; never hand the renderer a clipped value.
                *sample = (*sample * gain).clamp(-1.0, 1.0);
            }
        }
    }
}

struct State {
    input: Option<IMFMediaType>,
    output: Option<IMFMediaType>,
    pending: Option<IMFSample>,
    dsp: Dsp,
    was_enabled: bool,
}

#[implement(IMFTransform)]
pub struct Compressor {
    switch: Switch,
    state: Mutex<State>,
}

impl Compressor {
    pub fn new(switch: Switch) -> Self {
        Self {
            switch,
            state: Mutex::new(State {
                input: None,
                output: None,
                pending: None,
                dsp: Dsp {
                    sample_rate: 48_000.0,
                    channels: 2,
                    reduction: 0.0,
                },
                was_enabled: false,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Float PCM only; Media Foundation inserts a converter in front if needed.
fn float_audio(media_type: &IMFMediaType) -> Option<(u32, u32)> {
    // SAFETY: plain attribute reads on a live media type.
    unsafe {
        let major = media_type.GetGUID(&MF_MT_MAJOR_TYPE).ok()?;
        let subtype = media_type.GetGUID(&MF_MT_SUBTYPE).ok()?;
        if major != MFMediaType_Audio || subtype != MFAudioFormat_Float {
            return None;
        }
        if media_type.GetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE).unwrap_or(32) != 32 {
            return None;
        }
        let channels = media_type.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok()?;
        let rate = media_type.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok()?;
        (1..=16).contains(&channels).then_some((rate, channels)).filter(|(rate, _)| *rate > 0)
    }
}

fn partial_float_type() -> Result<IMFMediaType> {
    // SAFETY: a fresh media type owned by this function.
    unsafe {
        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
        Ok(media_type)
    }
}

fn copy_type(media_type: &IMFMediaType) -> Result<IMFMediaType> {
    // SAFETY: copies attributes into a fresh media type.
    unsafe {
        let copy = MFCreateMediaType()?;
        media_type.CopyAllItems(&copy)?;
        Ok(copy)
    }
}

fn check_stream(id: u32) -> Result<()> {
    if id == 0 { Ok(()) } else { Err(MF_E_INVALIDSTREAMNUMBER.into()) }
}

impl IMFTransform_Impl for Compressor_Impl {
    fn GetStreamLimits(&self, input_min: *mut u32, input_max: *mut u32, output_min: *mut u32, output_max: *mut u32) -> Result<()> {
        // SAFETY: Media Foundation passes valid out-pointers.
        unsafe {
            *input_min = 1;
            *input_max = 1;
            *output_min = 1;
            *output_max = 1;
        }
        Ok(())
    }

    fn GetStreamCount(&self, inputs: *mut u32, outputs: *mut u32) -> Result<()> {
        // SAFETY: as above.
        unsafe {
            *inputs = 1;
            *outputs = 1;
        }
        Ok(())
    }

    fn GetStreamIDs(&self, _: u32, _: *mut u32, _: u32, _: *mut u32) -> Result<()> {
        // Fixed stream IDs (0 and 0).
        Err(E_NOTIMPL.into())
    }

    fn GetInputStreamInfo(&self, id: u32, info: *mut MFT_INPUT_STREAM_INFO) -> Result<()> {
        check_stream(id)?;
        // SAFETY: valid out-pointer.
        unsafe {
            *info = MFT_INPUT_STREAM_INFO {
                hnsMaxLatency: 0,
                dwFlags: MFT_INPUT_STREAM_WHOLE_SAMPLES.0 as u32,
                cbSize: 0,
                cbMaxLookahead: 0,
                cbAlignment: 0,
            };
        }
        Ok(())
    }

    fn GetOutputStreamInfo(&self, id: u32) -> Result<MFT_OUTPUT_STREAM_INFO> {
        check_stream(id)?;
        // The sample that came in goes back out, processed in place.
        Ok(MFT_OUTPUT_STREAM_INFO {
            dwFlags: (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_WHOLE_SAMPLES.0) as u32,
            cbSize: 0,
            cbAlignment: 0,
        })
    }

    fn GetAttributes(&self) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }

    fn GetInputStreamAttributes(&self, _: u32) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }

    fn GetOutputStreamAttributes(&self, _: u32) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }

    fn DeleteInputStream(&self, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn AddInputStreams(&self, _: u32, _: *const u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn GetInputAvailableType(&self, id: u32, index: u32) -> Result<IMFMediaType> {
        check_stream(id)?;
        if index > 0 {
            return Err(MF_E_NO_MORE_TYPES.into());
        }
        match &self.state().output {
            Some(output) => copy_type(output),
            None => partial_float_type(),
        }
    }

    fn GetOutputAvailableType(&self, id: u32, index: u32) -> Result<IMFMediaType> {
        check_stream(id)?;
        if index > 0 {
            return Err(MF_E_NO_MORE_TYPES.into());
        }
        match &self.state().input {
            Some(input) => copy_type(input),
            None => partial_float_type(),
        }
    }

    fn SetInputType(&self, id: u32, media_type: Ref<'_, IMFMediaType>, flags: u32) -> Result<()> {
        check_stream(id)?;
        let mut state = self.state();
        if state.pending.is_some() {
            return Err(MF_E_TRANSFORM_CANNOT_CHANGE_MEDIATYPE_WHILE_PROCESSING.into());
        }
        let Some(media_type) = media_type.as_ref() else {
            if flags & MFT_SET_TYPE_TEST_ONLY.0 as u32 == 0 {
                state.input = None;
            }
            return Ok(());
        };
        let Some((rate, channels)) = float_audio(media_type) else {
            return Err(MF_E_INVALIDMEDIATYPE.into());
        };
        if let Some(output) = &state.output
            && float_audio(output) != Some((rate, channels))
        {
            return Err(MF_E_INVALIDMEDIATYPE.into());
        }
        if flags & MFT_SET_TYPE_TEST_ONLY.0 as u32 == 0 {
            state.input = Some(media_type.clone());
            state.dsp.sample_rate = rate as f32;
            state.dsp.channels = channels as usize;
            state.dsp.reduction = 0.0;
        }
        Ok(())
    }

    fn SetOutputType(&self, id: u32, media_type: Ref<'_, IMFMediaType>, flags: u32) -> Result<()> {
        check_stream(id)?;
        let mut state = self.state();
        if state.pending.is_some() {
            return Err(MF_E_TRANSFORM_CANNOT_CHANGE_MEDIATYPE_WHILE_PROCESSING.into());
        }
        let Some(media_type) = media_type.as_ref() else {
            if flags & MFT_SET_TYPE_TEST_ONLY.0 as u32 == 0 {
                state.output = None;
            }
            return Ok(());
        };
        let Some(format) = float_audio(media_type) else {
            return Err(MF_E_INVALIDMEDIATYPE.into());
        };
        // Output must match the input exactly: the samples pass through.
        if let Some(input) = &state.input
            && float_audio(input) != Some(format)
        {
            return Err(MF_E_INVALIDMEDIATYPE.into());
        }
        if flags & MFT_SET_TYPE_TEST_ONLY.0 as u32 == 0 {
            state.output = Some(media_type.clone());
        }
        Ok(())
    }

    fn GetInputCurrentType(&self, id: u32) -> Result<IMFMediaType> {
        check_stream(id)?;
        self.state()
            .input
            .as_ref()
            .map(copy_type)
            .unwrap_or_else(|| Err(MF_E_TRANSFORM_TYPE_NOT_SET.into()))
    }

    fn GetOutputCurrentType(&self, id: u32) -> Result<IMFMediaType> {
        check_stream(id)?;
        self.state()
            .output
            .as_ref()
            .map(copy_type)
            .unwrap_or_else(|| Err(MF_E_TRANSFORM_TYPE_NOT_SET.into()))
    }

    fn GetInputStatus(&self, id: u32) -> Result<u32> {
        check_stream(id)?;
        Ok(if self.state().pending.is_none() {
            MFT_INPUT_STATUS_ACCEPT_DATA.0 as u32
        } else {
            0
        })
    }

    fn GetOutputStatus(&self) -> Result<u32> {
        Ok(if self.state().pending.is_some() {
            MFT_OUTPUT_STATUS_SAMPLE_READY.0 as u32
        } else {
            0
        })
    }

    fn SetOutputBounds(&self, _: i64, _: i64) -> Result<()> {
        Ok(())
    }

    fn ProcessEvent(&self, _: u32, _: Ref<'_, IMFMediaEvent>) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn ProcessMessage(&self, message: MFT_MESSAGE_TYPE, _: usize) -> Result<()> {
        let mut state = self.state();
        if message == MFT_MESSAGE_COMMAND_FLUSH {
            state.pending = None;
            state.dsp.reduction = 0.0;
        } else if message == MFT_MESSAGE_NOTIFY_START_OF_STREAM {
            state.dsp.reduction = 0.0;
        }
        Ok(())
    }

    fn ProcessInput(&self, id: u32, sample: Ref<'_, IMFSample>, _: u32) -> Result<()> {
        check_stream(id)?;
        let mut state = self.state();
        if state.input.is_none() || state.output.is_none() {
            return Err(MF_E_TRANSFORM_TYPE_NOT_SET.into());
        }
        if state.pending.is_some() {
            return Err(MF_E_NOTACCEPTING.into());
        }
        state.pending = Some(sample.ok()?.clone());
        Ok(())
    }

    fn ProcessOutput(
        &self,
        _: u32,
        count: u32,
        buffers: *mut MFT_OUTPUT_DATA_BUFFER,
        status: *mut u32,
    ) -> Result<()> {
        if count != 1 || buffers.is_null() {
            return Err(windows::Win32::Foundation::E_INVALIDARG.into());
        }
        let mut state = self.state();
        let Some(sample) = state.pending.take() else {
            return Err(MF_E_TRANSFORM_NEED_MORE_INPUT.into());
        };
        self.switch.active.store(true, Ordering::Release);
        let enabled = self.switch.enabled.load(Ordering::Acquire);
        if enabled && !state.was_enabled {
            // Start from no reduction rather than a stale envelope.
            state.dsp.reduction = 0.0;
        }
        state.was_enabled = enabled;
        if enabled {
            // SAFETY: the buffer is locked for the duration of the slice and
            // holds `length` bytes of 32-bit float PCM per the negotiated type.
            unsafe {
                let buffer = sample.ConvertToContiguousBuffer()?;
                let mut data = std::ptr::null_mut();
                let mut length = 0u32;
                buffer.Lock(&mut data, None, Some(&mut length))?;
                if !data.is_null() && (data as usize).is_multiple_of(align_of::<f32>()) {
                    let samples =
                        std::slice::from_raw_parts_mut(data.cast::<f32>(), length as usize / size_of::<f32>());
                    state.dsp.process(samples);
                }
                buffer.Unlock()?;
            }
        }
        // SAFETY: one valid output buffer; this transform provides the sample,
        // so the caller's pSample is empty and takes our reference.
        unsafe {
            let output = &mut *buffers;
            output.pSample = std::mem::ManuallyDrop::new(Some(sample));
            output.dwStatus = 0;
            if !status.is_null() {
                *status = 0;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_matches_the_webaudio_settings() {
        // Well below the knee: untouched.
        assert!((curve(-40.0) + 40.0).abs() < 1e-4);
        // Far above: 4:1 from the threshold.
        assert!((curve(0.0) - -13.5).abs() < 1e-4);
        // Continuous at the knee edges.
        assert!((curve(-24.0) + 24.0).abs() < 1e-3);
        assert!((curve(-12.0) - (THRESHOLD_DB + 6.0 / RATIO)).abs() < 1e-3);
        assert!((makeup_db() - 8.1).abs() < 1e-3);
    }

    #[test]
    fn loud_audio_is_turned_down_and_quiet_audio_up() {
        let mut dsp = Dsp { sample_rate: 48_000.0, channels: 2, reduction: 0.0 };
        let mut loud = vec![0.9f32; 48_000 * 2];
        dsp.process(&mut loud);
        let settled = loud[loud.len() - 1];
        assert!(settled < 0.9, "loud audio was not reduced: {settled}");
        assert!(loud.iter().all(|sample| sample.abs() <= 1.0));

        let mut dsp = Dsp { sample_rate: 48_000.0, channels: 2, reduction: 0.0 };
        let mut quiet = vec![0.01f32; 4_800 * 2];
        dsp.process(&mut quiet);
        assert!(quiet[quiet.len() - 1] > 0.02, "quiet audio got no make-up gain");
    }
}
