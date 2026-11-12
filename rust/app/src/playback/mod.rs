//! Live playback. See `pipeline.rs` for the current path and the README for
//! where it is heading.

mod audio;
mod job;
mod pipeline;
mod shared;
mod tools;

pub use pipeline::{Pipeline, Watch};
