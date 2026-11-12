//! Sound output through WASAPI. FFmpeg resamples to the device's own rate and
//! channel count, so samples go to the card unchanged.

use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, SampleFormat, SizedSample, StreamConfig, SupportedStreamConfig};

use super::shared::Shared;

pub struct Output {
    device: Device,
    config: SupportedStreamConfig,
}

impl Output {
    pub fn default_device() -> Result<Self> {
        let device = cpal::default_host()
            .default_output_device()
            .context("No sound output device was found.")?;
        let config = device
            .default_output_config()
            .context("The sound output device has no usable format.")?;
        Ok(Self { device, config })
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate()
    }

    pub fn channels(&self) -> usize {
        usize::from(self.config.channels())
    }

    pub fn start(self, shared: Arc<Shared>) -> Result<cpal::Stream> {
        let config = self.config.config();
        let stream = match self.config.sample_format() {
            SampleFormat::F32 => build::<f32>(&self.device, config, shared),
            SampleFormat::I16 => build::<i16>(&self.device, config, shared),
            SampleFormat::I32 => build::<i32>(&self.device, config, shared),
            SampleFormat::U16 => build::<u16>(&self.device, config, shared),
            other => bail!("The sound device uses an unsupported format ({other})."),
        }?;
        stream.play().context("Could not start sound output.")?;
        Ok(stream)
    }
}

fn build<T>(device: &Device, config: StreamConfig, shared: Arc<Shared>) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let mut played = 0u64;
    let mut scratch: Vec<f32> = Vec::new();
    let muted = std::env::args().any(|arg| arg == "--mute-video");
    device
        .build_output_stream::<T, _, _>(
            config,
            move |output: &mut [T], _| {
                scratch.resize(output.len(), 0.0);
                shared.fill_audio(&mut scratch, &mut played);
                for (slot, sample) in output.iter_mut().zip(&scratch) {
                    *slot = T::from_sample(if muted { 0.0 } else { *sample });
                }
            },
            // Device changes and glitches surface as silence; nothing to log
            // that would help, and nothing secret either way.
            |_| {},
            None,
        )
        .context("Could not open sound output.")
}
