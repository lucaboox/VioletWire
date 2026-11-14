`cutter.mpegts` is generated test video (testsrc2) and a sine wave, not a captured
broadcast. It contains two seconds of 60 fps H.264 with B frames, one key frame,
AAC audio and repeated PAT/PMT tables. Generate with FFmpeg:

```
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=60 -f lavfi -i sine=frequency=880:sample_rate=48000 -t 2 -c:v libx264 -preset veryfast -g 120 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 64k -f mpegts cutter.mpegts
```

`cutter.mp4` repeats that generated input four times and remuxes it into
eight seconds of CMAF-style H.264/AAC. It has an empty initial movie header,
100 ms fragments, relative fragment offsets and no trailer index. The native
reader test holds the HTTP connection open: it must deliver a compressed frame
without waiting for EOF. More than 256 KiB is provided because the native MP4
reader performs read-ahead.

```
ffmpeg -stream_loop 3 -i cutter.mpegts -c copy -bsf:a aac_adtstoasc -movflags empty_moov+default_base_moof+frag_keyframe+skip_trailer -frag_duration 100000 -f mp4 cutter.mp4
```
