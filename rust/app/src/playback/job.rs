//! A Windows Job object for one playback. Closing it kills every process in it,
//! and Windows closes it for us if VioletWire exits or crashes, so Streamlink
//! and FFmpeg can never be left running.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::process::Child;

use anyhow::{Context as _, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};
use windows::core::PCWSTR;

pub struct Job(HANDLE);

// SAFETY: a job object handle is a kernel handle, usable from any thread; the
// struct only ever closes it once, in `drop`.
unsafe impl Send for Job {}

impl Job {
    pub fn new() -> Result<Self> {
        // SAFETY: plain Win32 calls on a handle this struct owns; the limit
        // structure outlives the call that reads it.
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null()).context("Could not create a playback job.")?;
            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .context("Could not configure the playback job.")?;
            Ok(job)
        }
    }

    pub fn assign(&self, child: &Child) -> Result<()> {
        // SAFETY: the child's handle stays valid while `child` is borrowed.
        unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())) }
            .context("Could not attach a playback process to its job.")
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is owned and closed exactly once.
        unsafe {
            let _ = TerminateJobObject(self.0, 1);
            let _ = CloseHandle(self.0);
        }
    }
}
