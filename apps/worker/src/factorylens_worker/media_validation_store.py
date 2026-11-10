from __future__ import annotations

from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from factorylens_worker.media_validation import InspectedMediaMetadata

_RECORD_MEDIA_METADATA = """
update inspections as inspection
set
    inspected_content_type = %s,
    inspected_size_bytes = %s,
    inspected_duration_ms = %s,
    inspected_width = %s,
    inspected_height = %s,
    inspected_container = %s,
    inspected_frame_rate = %s,
    inspected_streams = %s,
    updated_at = statement_timestamp()
from jobs as job
where job.id = %s
  and job.inspection_id = inspection.id
  and job.status = 'running'
  and job.lease_token = %s
  and job.lease_expires_at > statement_timestamp()
  and job.cancel_requested_at is null
returning inspection.id
"""


class PostgresMediaMetadataStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def record(
        self,
        job_id: UUID,
        lease_token: UUID,
        metadata: InspectedMediaMetadata,
    ) -> bool:
        with psycopg.connect(self._database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    _RECORD_MEDIA_METADATA,
                    (
                        metadata.content_type,
                        metadata.size_bytes,
                        metadata.duration_ms,
                        metadata.width,
                        metadata.height,
                        metadata.container,
                        metadata.frame_rate,
                        Jsonb([stream.as_json() for stream in metadata.streams]),
                        job_id,
                        lease_token,
                    ),
                )
                return cursor.fetchone() is not None
