# Processing envelope benchmark

## Decision status

This report records the repeatable credential-free benchmark for issue #38 and
the deployment configuration that it exercises. The local run passes the
media, memory, artifact, and browser checks for the configured ceiling. It does
not authorize opening uploads to real users: the controlled deployed run below
must still pass against Neon, R2, Cloud Run, Cloud Tasks, and the selected
Roboflow Workflow. Those services were not called from the development
workspace because no production credentials were present.

If the deployed five-minute case cannot finish comfortably inside the
30-minute Cloud Tasks deadline, lower the media envelope and open a separate
architecture decision for chunked work or Cloud Run Jobs. Do not increase the
deadline or conceal the result by raising a user limit.

## Reproduce the local run

Use the supported Node, Python, uv, FFmpeg, and Playwright setup, then run:

```sh
npm run benchmark:envelope
```

The command generates every input outside the repository, exercises the real
worker media validation, optional normalization, five-frame-per-second
sampling, prediction artifact creation, and a headless Chromium artifact load.
It writes the machine-readable result to
[`benchmarks/processing-envelope/local.json`](./benchmarks/processing-envelope/local.json).
No cloud account or credential is used. Generated video and uncompressed
artifacts are intentionally not committed.

The boundary MP4 contains five minutes of 1920-by-1080 H.264/AAC media and is
padded with trailing bytes tolerated by ffprobe to exactly 250 MiB. FactoryLens
still performs its real bounded object copies. The
prediction densities range from 1 to 12 predictions per sampled frame.

## Input matrix

| Role          | Duration | Resolution | Container and streams   | Predictions/frame | Expected path           |
| ------------- | -------: | ---------: | ----------------------- | ----------------: | ----------------------- |
| Short         |     10 s |    640×360 | WebM, VP8, no audio     |                 1 | Pass through            |
| Average       |     60 s |   1280×720 | WebM, VP9/Opus          |                 4 | Pass through            |
| Average       |     60 s |   1280×720 | MP4, H.264/AAC          |                 8 | Pass through            |
| Boundary      |    300 s |  1920×1080 | MP4, H.264/AAC, 250 MiB |                12 | Pass through            |
| Normalization |     60 s |   1280×720 | AVI, MPEG-4, no audio   |                 4 | H.264 MP4 normalization |

This covers every pass-through video codec and container family, both allowed
audio families, the normalization path, short/average/boundary durations and
resolutions, the upload byte boundary, and increasing prediction density.

## Local result

Measured on 2026-11-16 with a 14-core Apple arm64 machine, Python 3.14.7, and
FFmpeg 7.1.1. Times are single-run engineering measurements, not user latency
claims. Peak Python and FFmpeg memory are separate process high-water marks and
must not be added as if they occurred at the same instant.

| Case             | ffprobe |  Normalize | Sample + synthetic Workflow | Artifact | End to end | Python peak RSS | Child peak RSS |
| ---------------- | ------: | ---------: | --------------------------: | -------: | ---------: | --------------: | -------------: |
| Short VP8        | 44.7 ms |          — |                     61.7 ms |   1.5 ms |   110.1 ms |          68 MiB |         55 MiB |
| Average VP9      | 49.7 ms |          — |                    330.4 ms |   6.9 ms |   393.7 ms |          92 MiB |        127 MiB |
| Average H.264    | 48.4 ms |          — |                    321.3 ms |  11.2 ms |   395.1 ms |          92 MiB |        164 MiB |
| Boundary H.264   | 47.1 ms |          — |                  3,201.4 ms |  68.4 ms | 3,554.3 ms |         495 MiB |        305 MiB |
| Normalize MPEG-4 | 95.4 ms | 2,462.4 ms |                    326.0 ms |   6.7 ms | 2,904.0 ms |          85 MiB |        271 MiB |

The exact 250 MiB boundary local-storage write took 136.4 ms. This validates
bounded copying but is not a browser-to-R2 throughput measurement.

The boundary case produced 1,500 frames and 18,000 predictions. Its artifact
was 2,161,653 bytes as JSON and 57,348 bytes as deterministic gzip. Across five
Chromium loads, median fetch/decompression/parse/total time was
1.8/0.9/5.1/7.6 ms; median heap growth was 1,974,252 bytes. This is safely below
the browser's 32 MiB decoded-artifact guard.

The synthetic Workflow itself consumed only 69.0 ms at the boundary. That
number deliberately excludes Roboflow latency and quota behavior and therefore
cannot be used to approve the 30-minute task deadline.

## Configured safety ceiling

Terraform now supplies the application values from validated variables, so
the web and worker cannot drift on upload size and deployment plans reject
values beyond the approved architecture envelope.

| Control                          |              Configured value | Enforcement                                                       |
| -------------------------------- | ----------------------------: | ----------------------------------------------------------------- |
| Upload size                      |                       250 MiB | Browser/API declaration, object verification, worker bounded copy |
| Media duration                   |                     5 minutes | Worker ffprobe result                                             |
| Display resolution               | 1920×1080, either orientation | Worker ffprobe result                                             |
| Active inspections               |                    3 per user | Owner-scoped API quota                                            |
| Processing attempts              |                             3 | API job and Cloud Tasks retry configuration                       |
| Terminal artifact/data retention |                       30 days | Authenticated maintenance transaction                             |
| Abandoned upload retention       |                      24 hours | Authenticated maintenance transaction                             |
| Worker CPU and memory            |                  2 CPU, 4 GiB | Cloud Run container limits                                        |
| Worker request concurrency       |                             1 | Cloud Run and Terraform validation                                |
| Worker/task timeout              |                       1,800 s | Cloud Run timeout and Cloud Tasks deadline                        |
| Queue dispatch                   |             1 concurrent, 1/s | Cloud Tasks queue                                                 |
| Runtime database clients         |                    17 maximum | 3 web × 5, 1 worker, 1 migration operator                         |

The 4 GiB worker allocation leaves substantial headroom over the local memory
high-water marks. Concurrency remains one because frame bytes and accumulated
predictions are owned by a request, and because serial dispatch protects the
current Neon and Roboflow capacities. Retrying three times remains bounded and
does not justify admitting more active work. Retention is a product and storage
policy rather than a performance-derived value; 30 days remains the approved
maximum.

## Required deployed capacity gate

Run this gate from an authorized operator environment against the candidate
revision before enabling real-user uploads. It intentionally mutates only test
inspections owned by invited benchmark accounts.

1. Confirm the deployed revision uses the values above and that the queue has
   one concurrent dispatch. Record the image digest and region in the result.
2. Upload the same generated matrix through the browser. Record direct R2
   transfer duration and retry count, processing stage durations, artifact
   bytes, browser load/parse time, and end-to-end latency.
3. Submit three active inspections for each benchmark account in one controlled
   burst. Keep dispatch at one; queued jobs are expected. Record oldest-job age,
   Cloud Tasks attempts, and completion order.
4. From Cloud Run metrics, record worker peak memory and CPU utilization,
   instance count, request latency, and deadline/5xx counts. Pass requires no
   OOM, deadline, or unexpected retry and at least 20% memory headroom.
5. From Neon, record peak pooled clients and connection errors. Pass requires
   no connection error and no more than the configured 17 application clients.
6. From Roboflow, record request count, latency, rate-limit responses, and the
   applicable request/credit ceiling. Pass requires no `429` or quota failure
   during the controlled run and documented remaining capacity.
7. Repeat the largest artifact load five times in desktop Chromium and a tablet
   viewport. Pass requires decoded bytes below 32 MiB with no load failure or
   long task over 100 ms.
8. Record p50 and maximum values rather than averaging away the boundary case.
   Attach sanitized metric exports; never record credentials, signed URLs, raw
   private frames, or session cookies.

Do not mark this gate passed from the local JSON. Until its measurements are
recorded, Neon/Roboflow capacity and the HTTP task deadline acceptance criteria
remain open.
