//! A bounded local IMFByteStream. Media Engine's HTTP/HLS download cache is
//! bypassed; only compressed TS bytes cross this queue, never decoded pixels.
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::{E_INVALIDARG, E_NOTIMPL},
        Media::MediaFoundation::*,
        System::Com::*,
    },
    core::{BOOL, GUID, Interface, Ref, Result, implement},
};

const MAX_BUFFER: usize = 4 * 1024 * 1024;
const READ_COUNT: GUID = GUID::from_u128(0x938ccfb9_ea8a_4740_8b10_d22187f3fa41);
#[derive(Default)]
struct Buffer {
    bytes: VecDeque<u8>,
    history: VecDeque<u8>,
    position: u64,
    ended: bool,
}
struct Shared {
    data: Mutex<Buffer>,
    wake: Condvar,
    closed: AtomicBool,
    busy: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
    reads: mpsc::SyncSender<ReadJob>,
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}
impl Shared {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(socket) = lock(&self.socket).as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.wake.notify_all();
    }
    fn read(&self, out: &mut [u8]) -> Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        let mut data = lock(&self.data);
        let mut count = 0;
        // IMFByteStream short reads mean EOF. Network packet boundaries must
        // not leak into the demuxer's file-style read contract.
        while count < out.len() {
            while data.bytes.is_empty() && !data.ended && !self.closed.load(Ordering::Acquire) {
                data = self.wake.wait(data).unwrap_or_else(PoisonError::into_inner);
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(MF_E_SHUTDOWN.into());
            }
            if data.bytes.is_empty() {
                break;
            }
            let available = (out.len() - count).min(data.bytes.len());
            for byte in &mut out[count..count + available] {
                *byte = data.bytes.pop_front().unwrap();
                data.history.push_back(*byte);
            }
            count += available;
            data.position += available as u64;
            while data.history.len() > MAX_BUFFER {
                data.history.pop_front();
            }
            self.wake.notify_all();
        }
        Ok(count)
    }
    fn push(&self, bytes: &[u8]) -> bool {
        if bytes.len() > MAX_BUFFER {
            return false;
        }
        let mut data = lock(&self.data);
        while data.bytes.len() + bytes.len() > MAX_BUFFER && !self.closed.load(Ordering::Acquire) {
            data = self.wake.wait(data).unwrap_or_else(PoisonError::into_inner);
        }
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        data.bytes.extend(bytes);
        self.wake.notify_all();
        true
    }
    fn seek(&self, target: u64) -> Result<()> {
        let mut data = lock(&self.data);
        if target < data.position {
            let count = data.position - target;
            if count > data.history.len() as u64 {
                return Err(MF_E_INVALIDREQUEST.into());
            }
            for _ in 0..count {
                let byte = data.history.pop_back().unwrap();
                data.bytes.push_front(byte);
            }
        } else {
            let count = target - data.position;
            if count > MAX_BUFFER as u64 {
                return Err(MF_E_INVALIDREQUEST.into());
            }
            while count > data.bytes.len() as u64
                && !data.ended
                && !self.closed.load(Ordering::Acquire)
            {
                data = self.wake.wait(data).unwrap_or_else(PoisonError::into_inner);
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(MF_E_SHUTDOWN.into());
            }
            if count > data.bytes.len() as u64 {
                return Err(MF_E_INVALIDREQUEST.into());
            }
            for _ in 0..count {
                let byte = data.bytes.pop_front().unwrap();
                data.history.push_back(byte);
            }
            while data.history.len() > MAX_BUFFER {
                data.history.pop_front();
            }
        }
        data.position = target;
        self.wake.notify_all();
        Ok(())
    }
}
struct ReadJob {
    address: usize,
    length: usize,
    result: IMFAsyncResult,
    counts: IMFAttributes,
}
// SAFETY: MFCreateAsyncResult and MFCreateAttributes return free-threaded MF
// objects; byte-stream asynchronous callbacks are required to support MF work
// queues. No apartment-bound application COM object is put into this queue.
unsafe impl Send for ReadJob {}

pub struct Input {
    pub stream: IMFByteStream,
    shared: Arc<Shared>,
    network: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct Reader(Arc<Shared>);
impl Reader {
    pub fn close(&self) {
        self.0.close();
    }
}
impl Input {
    pub fn close(&self) {
        self.shared.close();
    }
    pub fn reader(&self) -> Reader {
        Reader(self.shared.clone())
    }
    pub fn open(url: &str) -> anyhow::Result<Self> {
        let uri: ureq::http::Uri = url
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid local media source."))?;
        anyhow::ensure!(
            uri.scheme_str() == Some("http")
                && uri.host() == Some("127.0.0.1")
                && uri
                    .authority()
                    .is_some_and(|authority| !authority.as_str().contains('@')),
            "Invalid local media source."
        );
        let port = uri
            .port_u16()
            .ok_or_else(|| anyhow::anyhow!("Missing local media port."))?;
        let path = uri.path().to_owned();
        let (send, receive) = mpsc::sync_channel::<ReadJob>(1);
        let shared = Arc::new(Shared {
            data: Mutex::new(Buffer::default()),
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            socket: Mutex::new(None),
            reads: send,
        });
        let stream: IMFByteStream = Stream(shared.clone()).into();
        let reading = shared.clone();
        let reader = std::thread::Builder::new()
            .name("vw-local-byte-read".into())
            .spawn(move || {
                // The byte-stream work queue is independent of the UI thread.
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                while !reading.closed.load(Ordering::Acquire) {
                    let job = match receive.recv_timeout(Duration::from_millis(50)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    // SAFETY: BeginRead's caller owns this buffer until its async
                    // completion. Lengths are bounded and one read is in flight.
                    let output = unsafe {
                        std::slice::from_raw_parts_mut(job.address as *mut u8, job.length)
                    };
                    let result = reading.read(output);
                    unsafe {
                        let status = match result {
                            Ok(count) => job.counts.SetUINT32(&READ_COUNT, count as u32),
                            Err(error) => Err(error),
                        };
                        let _ = job.result.SetStatus(
                            status.map_or_else(|error| error.code(), |_| windows::core::HRESULT(0)),
                        );
                        reading.busy.store(false, Ordering::Release);
                        let _ = MFInvokeCallback(&job.result);
                    }
                }
                // Cancel a queued read too, before the engine's MF platform exits.
                while let Ok(job) = receive.try_recv() {
                    unsafe {
                        let _ = job.result.SetStatus(MF_E_SHUTDOWN);
                        let _ = MFInvokeCallback(&job.result);
                    }
                }
                unsafe {
                    CoUninitialize();
                }
            })?;
        let networking = shared.clone();
        let network = match std::thread::Builder::new()
            .name("vw-local-byte-feed".into())
            .spawn(move || {
                let _ = receive_media(&networking, port, &path);
                lock(&networking.data).ended = true;
                networking.wake.notify_all();
            }) {
            Ok(thread) => thread,
            Err(error) => {
                shared.close();
                let _ = reader.join();
                return Err(error.into());
            }
        };
        Ok(Self {
            stream,
            shared,
            network: Some(network),
            reader: Some(reader),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shared() -> Arc<Shared> {
        let (reads, _) = mpsc::sync_channel(1);
        Arc::new(Shared {
            data: Mutex::new(Buffer::default()),
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            socket: Mutex::new(None),
            reads,
        })
    }
    #[test]
    fn reads_preserve_byte_order_position_eof_and_unknown_length() {
        let shared = shared();
        let stream: IMFByteStream = Stream(shared.clone()).into();
        let bytes: Vec<u8> = (0..10000).map(|n| (n % 251) as u8).collect();
        assert!(shared.push(&bytes));
        let mut result = vec![0; bytes.len()];
        let mut count = 0;
        unsafe {
            assert_eq!(stream.GetLength().unwrap(), u64::MAX);
            stream.Read(&mut result, &mut count).unwrap();
            assert_eq!(stream.GetCurrentPosition().unwrap(), bytes.len() as u64);
            assert!(!stream.IsEndOfStream().unwrap().as_bool());
            stream.SetCurrentPosition(0).unwrap();
            stream.Read(&mut result, &mut count).unwrap();
        }
        assert_eq!(result, bytes);
        assert_eq!(count as usize, bytes.len());
        lock(&shared.data).ended = true;
        assert_eq!(shared.read(&mut [0; 16]).unwrap(), 0);
        assert!(unsafe { stream.IsEndOfStream().unwrap().as_bool() });
    }
    #[test]
    fn close_wakes_a_blocked_read_and_oversized_writes_are_rejected() {
        let shared = shared();
        assert!(!shared.push(&vec![0; MAX_BUFFER + 1]));
        let reader = shared.clone();
        let thread = std::thread::spawn(move || reader.read(&mut [0; 188]));
        shared.close();
        assert!(thread.join().unwrap().is_err());
        assert!(!shared.push(&[1]));
    }
    #[test]
    fn network_chunks_do_not_become_short_reads_but_eof_does() {
        let shared = shared();
        assert!(shared.push(&[1; 20]));
        let reading = shared.clone();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut output = [0; 64];
            let count = reading.read(&mut output).unwrap();
            send.send((count, output)).unwrap();
        });
        let data = lock(&shared.data);
        let (data, timeout) = shared
            .wake
            .wait_timeout_while(data, Duration::from_secs(2), |data| data.position < 20)
            .unwrap();
        assert!(!timeout.timed_out());
        drop(data);
        assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(shared.push(&[2; 44]));
        let (count, output) = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(count, 64);
        assert_eq!(&output[..20], &[1; 20]);
        assert_eq!(&output[20..], &[2; 44]);
        worker.join().unwrap();
        assert!(shared.push(&[3; 10]));
        lock(&shared.data).ended = true;
        assert_eq!(shared.read(&mut [0; 64]).unwrap(), 10);
    }
    #[test]
    fn rejects_remote_or_credentialed_media_addresses_before_connecting() {
        for url in [
            "https://example.com/live.ts",
            "http://localhost:9000/x",
            "http://user@127.0.0.1:9000/x",
            "file:///private",
        ] {
            assert!(Input::open(url).is_err());
        }
    }
    #[test]
    fn fragmented_mp4_native_reader_accepts_unknown_length_compressed_input() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
            {
                let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                let port = listener.local_addr().unwrap().port();
                let (finish, finished) = mpsc::channel();
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = BufReader::new(socket.try_clone().unwrap());
                    let mut line = String::new();
                    loop {
                        line.clear();
                        request.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                    }
                    socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: video/mp4\r\n\r\n").unwrap();
                    let bytes = include_bytes!("fixtures/cutter.mp4");
                    write!(socket, "{:x}\r\n", bytes.len()).unwrap();
                    socket.write_all(bytes).unwrap();
                    socket.write_all(b"\r\n").unwrap();
                    let _ = finished.recv_timeout(Duration::from_secs(2));
                    let _ = socket.write_all(b"0\r\n\r\n");
                });
                let opening = std::time::Instant::now();
                let input = Input::open(&format!("http://127.0.0.1:{port}/fixture.mp4")).unwrap();
                let resolver = MFCreateSourceResolver().unwrap();
                let mut kind = MF_OBJECT_INVALID;
                let mut object = None;
                resolver
                    .CreateObjectFromByteStream(
                        &input.stream,
                        windows::core::w!("fixture.mp4"),
                        MF_RESOLUTION_MEDIASOURCE.0 as u32,
                        None,
                        &mut kind,
                        &mut object,
                    )
                    .unwrap();
                let source: IMFMediaSource = object.unwrap().cast().unwrap();
                let reader = MFCreateSourceReaderFromMediaSource(&source, None).unwrap();
                let video = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
                let native = reader.GetNativeMediaType(video, 0).unwrap();
                eprintln!(
                    "[mp4-probe] native_subtype={:?}",
                    native.GetGUID(&MF_MT_SUBTYPE).unwrap()
                );
                reader
                    .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                    .unwrap();
                reader.SetCurrentMediaType(video, None, &native).unwrap();
                reader.SetStreamSelection(video, true).unwrap();
                let mut sample = None;
                let (mut stream_index, mut flags, mut timestamp) = (0, 0, 0);
                reader
                    .ReadSample(
                        video,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .unwrap();
                assert!(sample.unwrap().GetTotalLength().unwrap() > 0);
                let elapsed = opening.elapsed();
                let _ = finish.send(());
                input.close();
                let _ = source.Shutdown();
                drop(reader);
                server.join().unwrap();
                assert!(
                    elapsed < Duration::from_millis(1500),
                    "native MP4 waited for EOF: {elapsed:?}"
                );
            }
            MFShutdown().unwrap();
            CoUninitialize();
        }
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        self.shared.close();
        if let Some(thread) = self.network.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.reader.take() {
            let _ = thread.join();
        }
    }
}

fn receive_media(shared: &Shared, port: u16, path: &str) -> std::io::Result<()> {
    let mut socket =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    *lock(&shared.socket) = Some(socket.try_clone()?);
    if shared.closed.load(Ordering::Acquire) {
        return Ok(());
    }
    write!(
        socket,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut reader = BufReader::new(socket);
    let mut header = String::new();
    let mut size = 0;
    loop {
        header.clear();
        reader.by_ref().take(8193).read_line(&mut header)?;
        size += header.len();
        if size > 8192 || header.is_empty() {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        if size == header.len() && !header.starts_with("HTTP/1.1 200 ") {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        if header == "\r\n" {
            break;
        }
    }
    let mut buffer = [0u8; 32 * 1024];
    while !shared.closed.load(Ordering::Acquire) {
        header.clear();
        reader.by_ref().take(65).read_line(&mut header)?;
        let length = usize::from_str_radix(header.trim(), 16)
            .map_err(|_| std::io::ErrorKind::InvalidData)?;
        if length == 0 {
            return Ok(());
        }
        if length > 16 * 1024 * 1024 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let mut left = length;
        while left > 0 {
            let count = left.min(buffer.len());
            reader.read_exact(&mut buffer[..count])?;
            if !shared.push(&buffer[..count]) {
                return Ok(());
            }
            left -= count;
        }
        let mut tail = [0; 2];
        reader.read_exact(&mut tail)?;
        if tail != *b"\r\n" {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
    Ok(())
}

#[implement(IMFByteStream)]
struct Stream(Arc<Shared>);
impl IMFByteStream_Impl for Stream_Impl {
    fn GetCapabilities(&self) -> Result<u32> {
        Ok(MFBYTESTREAM_IS_READABLE
            | MFBYTESTREAM_IS_SEEKABLE
            | MFBYTESTREAM_IS_PARTIALLY_DOWNLOADED)
    }
    fn GetLength(&self) -> Result<u64> {
        Ok(u64::MAX)
    }
    fn SetLength(&self, _: u64) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetCurrentPosition(&self) -> Result<u64> {
        Ok(lock(&self.0.data).position)
    }
    fn SetCurrentPosition(&self, position: u64) -> Result<()> {
        self.0.seek(position)
    }
    fn IsEndOfStream(&self) -> Result<BOOL> {
        let data = lock(&self.0.data);
        Ok((data.ended && data.bytes.is_empty()).into())
    }
    fn Read(&self, bytes: *mut u8, count: u32, read: *mut u32) -> Result<()> {
        if bytes.is_null() || read.is_null() || count as usize > MAX_BUFFER {
            return Err(E_INVALIDARG.into());
        }
        // SAFETY: COM caller supplies the stated writable output range.
        unsafe {
            *read = self
                .0
                .read(std::slice::from_raw_parts_mut(bytes, count as usize))?
                as u32;
        }
        Ok(())
    }
    fn BeginRead(
        &self,
        bytes: *mut u8,
        count: u32,
        callback: Ref<'_, IMFAsyncCallback>,
        state: Ref<'_, windows::core::IUnknown>,
    ) -> Result<()> {
        if bytes.is_null() || count as usize > MAX_BUFFER {
            return Err(E_INVALIDARG.into());
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(MF_E_SHUTDOWN.into());
        }
        if self.0.busy.swap(true, Ordering::AcqRel) {
            return Err(MF_E_NOTACCEPTING.into());
        }
        let result = (|| unsafe {
            let mut counts = None;
            MFCreateAttributes(&mut counts, 1)?;
            let counts = counts.unwrap();
            let result = MFCreateAsyncResult(&counts, callback.as_ref(), state.as_ref())?;
            self.0
                .reads
                .try_send(ReadJob {
                    address: bytes as usize,
                    length: count as usize,
                    result,
                    counts,
                })
                .map_err(|_| windows::core::Error::from(MF_E_NOTACCEPTING))
        })();
        if result.is_err() {
            self.0.busy.store(false, Ordering::Release);
        }
        result
    }
    fn EndRead(&self, result: Ref<'_, IMFAsyncResult>) -> Result<u32> {
        unsafe {
            let result = result.ok()?;
            result.GetStatus()?;
            result
                .GetObject()?
                .cast::<IMFAttributes>()?
                .GetUINT32(&READ_COUNT)
        }
    }
    fn Write(&self, _: *const u8, _: u32) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn BeginWrite(
        &self,
        _: *const u8,
        _: u32,
        _: Ref<'_, IMFAsyncCallback>,
        _: Ref<'_, windows::core::IUnknown>,
    ) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn EndWrite(&self, _: Ref<'_, IMFAsyncResult>) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn Seek(&self, origin: MFBYTESTREAM_SEEK_ORIGIN, offset: i64, _: u32) -> Result<u64> {
        let position = lock(&self.0.data).position;
        let target = if origin == msoCurrent {
            position.checked_add_signed(offset)
        } else if origin == msoBegin && offset >= 0 {
            Some(offset as u64)
        } else {
            None
        }
        .ok_or_else(|| windows::core::Error::from(MF_E_INVALIDREQUEST))?;
        self.0.seek(target)?;
        Ok(target)
    }
    fn Flush(&self) -> Result<()> {
        Ok(())
    }
    fn Close(&self) -> Result<()> {
        self.0.close();
        Ok(())
    }
}
