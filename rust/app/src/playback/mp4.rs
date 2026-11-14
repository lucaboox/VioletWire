//! Bounded CMAF initialization and first-sample sync checks. Windows' native
//! MP4 source still demuxes the compressed samples; this does not decode video.
#[derive(Clone, Copy)]
struct Atom<'a> {
    kind: [u8; 4],
    body: &'a [u8],
}
fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn atoms(mut data: &[u8]) -> impl Iterator<Item = Atom<'_>> {
    std::iter::from_fn(move || {
        let mut size = u32_at(data, 0)? as usize;
        let header = if size == 1 {
            size = usize::try_from(u64::from_be_bytes(data.get(8..16)?.try_into().ok()?)).ok()?;
            16
        } else {
            8
        };
        if size < header || size > 16 * 1024 * 1024 {
            data = &[];
            return None;
        }
        let kind = data.get(4..8)?.try_into().ok()?;
        let body = data.get(header..size)?;
        data = data.get(size..)?;
        Some(Atom { kind, body })
    })
}
fn find<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    atoms(data)
        .find(|atom| &atom.kind == kind)
        .map(|atom| atom.body)
}
pub(super) struct VideoTracks(Vec<(u32, Option<u32>)>);
impl VideoTracks {
    pub(super) fn new(init: &[u8]) -> Option<Self> {
        if init.len() > 1024 * 1024 {
            return None;
        }
        let moov = find(init, b"moov")?;
        let defaults = find(moov, b"mvex");
        let mut tracks = Vec::new();
        for trak in atoms(moov).filter(|atom| &atom.kind == b"trak") {
            let header = find(trak.body, b"tkhd")?;
            let media = find(trak.body, b"mdia")?;
            let handler = find(media, b"hdlr")?;
            if handler.get(8..12)? != b"vide" {
                continue;
            }
            let offset = match *header.first()? {
                0 => 12,
                1 => 20,
                _ => return None,
            };
            let id = u32_at(header, offset)?;
            if id == 0 || tracks.len() >= 16 || tracks.iter().any(|(known, _)| *known == id) {
                return None;
            }
            let flags = defaults
                .and_then(|defaults| {
                    atoms(defaults)
                        .find(|atom| &atom.kind == b"trex" && u32_at(atom.body, 4) == Some(id))
                })
                .and_then(|atom| u32_at(atom.body, 20));
            tracks.push((id, flags));
        }
        (!tracks.is_empty()).then_some(Self(tracks))
    }
    pub(super) fn first_sync(&self, bytes: &[u8]) -> Option<bool> {
        let moof = find(bytes, b"moof")?;
        for traf in atoms(moof).filter(|atom| &atom.kind == b"traf") {
            let header = find(traf.body, b"tfhd")?;
            let id = u32_at(header, 4)?;
            let Some((_, defaults)) = self.0.iter().find(|(track, _)| *track == id) else {
                continue;
            };
            let flags = u32_at(header, 0)? & 0xffffff;
            let mut offset = 8;
            for (flag, size) in [(1, 8), (2, 4), (8, 4), (16, 4)] {
                if flags & flag != 0 {
                    offset += size;
                }
            }
            let defaults = if flags & 32 != 0 {
                Some(u32_at(header, offset)?)
            } else {
                *defaults
            };
            let run = find(traf.body, b"trun")?;
            if u32_at(run, 4)? == 0 {
                return None;
            }
            let flags = u32_at(run, 0)? & 0xffffff;
            let mut offset = 8 + usize::from(flags & 1 != 0) * 4;
            let sample_flags = if flags & 4 != 0 {
                u32_at(run, offset)?
            } else if flags & 0x400 != 0 {
                if flags & 0x100 != 0 {
                    offset += 4;
                }
                if flags & 0x200 != 0 {
                    offset += 4;
                }
                u32_at(run, offset)?
            } else {
                defaults?
            };
            return Some(sample_flags & 0x10000 == 0);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_cmaf_has_an_initial_sync_picture_and_later_non_sync_chunks() {
        let bytes = include_bytes!("fixtures/cutter.mp4");
        let tracks = VideoTracks::new(bytes);
        assert!(tracks.is_some());
        let tracks = tracks.unwrap();
        assert_eq!(tracks.first_sync(bytes), Some(true));
        // Fragment boundaries in the file can be found without touching media.
        let first_moof = bytes.windows(4).position(|word| word == b"moof").unwrap() - 4;
        let first_size = u32_at(bytes, first_moof).unwrap() as usize;
        assert_eq!(
            tracks.first_sync(&bytes[first_moof + first_size..]),
            Some(false)
        );
        for length in 0..first_moof + first_size {
            assert_eq!(tracks.first_sync(&bytes[..length]), None);
        }
    }
    #[test]
    fn malformed_and_oversized_atoms_fail_closed() {
        assert!(VideoTracks::new(&[0; 32]).is_none());
        assert!(VideoTracks::new(&vec![0; 1024 * 1024 + 1]).is_none());
        assert!(atoms(&[0xff; 16]).next().is_none());
        let extended = [
            0, 0, 0, 1, b'm', b'o', b'o', b'v', 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ];
        assert!(atoms(&extended).next().is_none());
    }
}
