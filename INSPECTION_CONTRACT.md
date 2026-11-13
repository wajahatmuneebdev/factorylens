# FactoryLens inspection contract

## 1. Status and scope

This document is the product contract for the first FactoryLens inspection.
Application code may depend on this contract unless a later reviewed change
replaces it.

The first inspection is deliberately narrow: it reviews recorded video for
workers who are not wearing hard hats. It is not a real-time alarm, a general
PPE classifier, or a generic Roboflow Workflow editor. Results support a human
safety review and must not be treated as proof that a work area is safe.

## 2. Scenario and user

The target user is an environmental health and safety lead at a vehicle
assembly plant. After a shift or incident, they upload recorded video from a
fixed camera covering a machine-dense assembly work cell where site policy
requires hard hats. FactoryLens shows people and hard-hat detections over the
video and highlights continuous periods in which a missing hard hat was
detected. The user can review those periods, filter low-confidence annotations,
and export the result for a safety follow-up.

The first version answers one question: **when did the recording show evidence
of a person without a hard hat?** It does not identify people, determine intent,
send alerts, monitor live cameras, or judge compliance for other PPE.

## 3. Workflow contract

### Identity

| Field | Contract value |
| --- | --- |
| FactoryLens workflow key | `factory-safety-v1` |
| Roboflow Workflow ID | `hard-hat-compliance-v1` |
| Roboflow Workflow version | `1` |
| Detection model | `construction-site-safety/27` |

The Roboflow workspace slug is deployment configuration because it is owned by
the account hosting the Workflow; it is not a product identifier. The worker
must invoke the exact Workflow ID and version above in the configured workspace.
Creating or deploying that Workflow is outside this contract task.

The selected public model is the Roboflow Universe
[Construction Site Safety model](https://universe.roboflow.com/roboflow-universe-projects/construction-site-safety),
version 27. The Workflow keeps only the model's `Person`, `Hardhat`, and
`NO-Hardhat` classes. Its initial model confidence threshold is `0.50`. A model
or Workflow version change requires a new fingerprint and fixture review; it
must not silently change an existing processing generation.

### Required input

The Workflow has one required input named `image`, containing one decoded RGB
video frame. FactoryLens samples the inspected video at 5 frames per second and
submits frames in presentation-timestamp order. The worker, not the Workflow,
owns video decoding, timestamps, batching, retries, and conversion into the
FactoryLens artifact.

The input frame retains the source display orientation. If normalization is
required, the worker records the normalized dimensions as the artifact source
dimensions and uses those dimensions for all boxes.

### Expected output

The Workflow exposes one JSON output named `predictions`. Each retained object
detection supplies:

- `class` — exactly `Person`, `Hardhat`, or `NO-Hardhat`;
- `confidence` — a finite number from 0 through 1;
- `x` and `y` — bounding-box center coordinates in input-frame pixels; and
- `width` and `height` — positive bounding-box dimensions in input-frame
  pixels.

The worker rejects a malformed Workflow response as a provider error. It clips
boxes to the frame, drops zero-area boxes, maps `class` to `className`, and
assigns a deterministic prediction ID from the frame index and prediction
ordinal. Provider detection IDs are not durable identifiers.

`Person` and `Hardhat` are displayed as context. Only a direct `NO-Hardhat`
detection may create a violation; the first version does not infer a violation
by trying to associate a separate `Person` box with a `Hardhat` box.

## 4. FactoryLens prediction schema

The worker writes one gzip-compressed JSON document. All times are integer
milliseconds on the media timeline, measured from the first displayed frame.
Frame timestamps come from decoded presentation timestamps rather than the
sampling loop's wall clock and must be monotonically increasing.

Each prediction contains:

| Field | Meaning |
| --- | --- |
| `id` | Deterministic ID unique within the artifact |
| `className` | `Person`, `Hardhat`, or `NO-Hardhat` |
| `confidence` | Model confidence from 0 through 1 |
| `box.x`, `box.y` | Box center in source-display pixels |
| `box.width`, `box.height` | Box size in source-display pixels |

Coordinates are source pixels, not normalized fractions. The browser scales
them to the displayed video and applies user-selected class and confidence
filters locally.

### Event rule

A `missing_hard_hat` event uses the following fixed initial rule:

1. A qualifying frame contains at least one `NO-Hardhat` prediction with
   confidence greater than or equal to `0.60`.
2. An event is confirmed when at least three of five consecutive sampled frames
   qualify. Its `startMs` is backdated to the first qualifying frame in that
   confirmation window.
3. A confirmed event remains open through brief detection gaps. It ends after
   five consecutive sampled frames do not qualify; `endMs` is the timestamp of
   the last qualifying frame.
4. Confirmed events separated by less than 1,000 ms are merged.
5. An event open at end-of-video ends at `source.durationMs`.

This rule produces time ranges for review, not person-level tracks. Two workers
without hard hats at the same time still produce one event for that time range.

Each event contains `id`, `type`, `label`, `startMs`, `endMs`,
`peakConfidence`, and `qualifyingFrameCount`. Summary counts are derived from
the final frames and events, not accepted as separate Workflow claims.

### Example artifact

The following compact example is complete for a one-second source clip:

```json
{
  "schemaVersion": 1,
  "inspectionId": "018f4f72-3d3a-7c1c-b10b-f2a7c849e830",
  "source": {
    "width": 1280,
    "height": 720,
    "durationMs": 1000,
    "timeBase": "milliseconds",
    "sampleRateFps": 5
  },
  "workflow": {
    "key": "factory-safety-v1",
    "workflowId": "hard-hat-compliance-v1",
    "workflowVersion": "1",
    "modelId": "construction-site-safety/27",
    "fingerprint": "sha256:4ad6c4f907778e721d638444ad0b6881bd1af563c5530c85e0a8ef376f7f0a61"
  },
  "classes": ["Person", "Hardhat", "NO-Hardhat"],
  "frames": [
    {
      "timestampMs": 0,
      "predictions": [
        {
          "id": "f000000-p000",
          "className": "NO-Hardhat",
          "confidence": 0.91,
          "box": {"x": 614, "y": 238, "width": 92, "height": 108}
        }
      ]
    },
    {
      "timestampMs": 200,
      "predictions": [
        {
          "id": "f000001-p000",
          "className": "NO-Hardhat",
          "confidence": 0.93,
          "box": {"x": 618, "y": 239, "width": 94, "height": 110}
        }
      ]
    },
    {
      "timestampMs": 400,
      "predictions": [
        {
          "id": "f000002-p000",
          "className": "NO-Hardhat",
          "confidence": 0.90,
          "box": {"x": 621, "y": 240, "width": 94, "height": 110}
        }
      ]
    },
    {"timestampMs": 600, "predictions": []},
    {"timestampMs": 800, "predictions": []}
  ],
  "events": [
    {
      "id": "event-000",
      "type": "missing_hard_hat",
      "label": "Missing hard hat",
      "startMs": 0,
      "endMs": 1000,
      "peakConfidence": 0.93,
      "qualifyingFrameCount": 3
    }
  ],
  "summary": {
    "missingHardHatEventCount": 1,
    "qualifyingFrameCount": 3,
    "peakConfidence": 0.93
  }
}
```

The fingerprint value illustrates the required format. A processing run records
the SHA-256 of the actual exported, versioned Workflow definition it used.

### Export contract

The authorized prediction download is the canonical gzip-compressed JSON
export. It is the committed artifact unchanged, including its `schemaVersion`,
and therefore preserves the complete versioned prediction contract.

The CSV export contains one row per frame prediction in timestamp order. Its
stable columns are:

| Column | Meaning |
| --- | --- |
| `inspection_id` | FactoryLens inspection UUID |
| `timestamp_ms` | Frame time on the media timeline |
| `prediction_id` | Deterministic prediction ID within the artifact |
| `class_name` | `Person`, `Hardhat`, or `NO-Hardhat` |
| `confidence` | Model confidence from 0 through 1 |
| `box_x`, `box_y` | Bounding-box center in source-display pixels |
| `box_width`, `box_height` | Bounding-box size in source-display pixels |

The header is present even when an artifact has no predictions. Events,
summary values, source metadata, and Workflow provenance remain available in
the JSON export rather than being flattened into unrelated CSV row types.

## 5. Sample media and expected fixture

The prepared violation sample is a normalized derivative of
[Assembly line.webm](https://commons.wikimedia.org/wiki/File:Assembly_line.webm),
a tractor assembly-line time lapse by Automotive garage. The source is licensed
under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/),
which permits redistribution and adaptation with attribution and an indication
of changes. FactoryLens will preserve that attribution beside the prepared
sample and in its distribution notices.

The selected source is a 7.341-second, 3422-by-2008 VP9 WebM file with published
SHA-1 `b73f54759ad8832f4547dd13b656c10ae3e5723a`. The prepared fixture takes the
first 2,000 ms, removes audio, samples at 5 frames per second, preserves display
orientation, and scales to an even 1840 by 1080 without cropping. The result is
10 frames with a 2,000 ms media duration. When repository scaffolding adds
binary fixtures, it will be stored as
`fixtures/media/assembly-line-no-hard-hat.webm`; its deterministic expected
event fixture will be stored as
`fixtures/predictions/assembly-line-no-hard-hat.expected.json`.

Manual review establishes the expected product-level fixture result:

- at least one worker is visible without a hard hat throughout the prepared
  clip;
- the result contains one continuous `missing_hard_hat` event from `0` through
  `2000` ms;
- `missingHardHatEventCount` is `1`; and
- the clip is a positive violation sample, not a model-accuracy benchmark.

Exact model confidences and boxes are intentionally not ground truth. The later
fixture runner will provide deterministic frame predictions that exercise this
event result, while opt-in Roboflow integration tests may measure the real model
separately. The expected result treats visible absence of hard hats as a
synthetic contract signal; it does not claim the depicted workers violated
their employer's actual policy or that the selected model is production-ready
for a specific plant.

## 6. Initial policy candidates

These are conservative starting values for implementation and benchmarking,
not final operational promises:

| Policy | Initial candidate |
| --- | --- |
| Maximum video duration | 5 minutes |
| Maximum uploaded object size | 250 MiB |
| Maximum display resolution | 1920 × 1080, allowing either orientation |
| Frame sampling rate | 5 frames per second |
| Original, normalized, and prediction artifact retention | 30 days after a terminal inspection state |
| Abandoned upload retention | 24 hours |
| Public portfolio uploads | No anonymous or arbitrary public uploads; uploads are limited to invited accounts |
| Prepared sample access | Available to authenticated users, including accounts without upload permission |

The server verifies actual size, duration, resolution, and media type. A client
declaration never overrides inspected media metadata. Before production launch,
benchmarks may lower or raise these configured values without changing the
prediction schema; increasing them beyond the current Cloud Tasks and browser
memory envelope requires an architecture review.

## 7. Architecture review

This contract fits the approved architecture:

- the browser presents private video, downloads one authorized prediction
  artifact, draws pixel-coordinate boxes on Canvas, filters locally, and
  exports only on request;
- Node owns authentication, ownership, policy validation, signed storage
  access, orchestration, and retention policy;
- the Python worker decodes and samples video, invokes the configured Workflow,
  validates provider output, applies event rules, and writes the artifact;
- PostgreSQL stores ownership, state, artifact references, and small summary
  values rather than video or per-frame predictions; and
- R2 remains the private store for source media and prediction artifacts.

No new service, datastore, queue, authentication system, live-video path,
notification system, model-training path, or generic Workflow feature is
introduced. Final media limits remain subject to the benchmarks already called
for by the architecture.
