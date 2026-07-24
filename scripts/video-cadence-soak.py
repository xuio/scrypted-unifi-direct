#!/usr/bin/env python3
"""Bounded simultaneous video/audio RTP validator for two RTSP streams.

The validator opens both sources before beginning one shared measurement window,
receives RTP/RTCP over RTSP interleaved TCP, and analyzes H.264 plus the advertised
audio track without retaining media or per-frame records. Results contain fixed-
size counters, histograms, and bounded anomaly rings; RTSP URLs and credentials
are never written to the report.

This is an end-to-end transport oracle.  It deliberately does not rewrite RTP
timestamps and does not use FFmpeg's decoded-frame timing, which can hide source
cadence defects through buffering or normalization.
"""

from __future__ import annotations

import argparse
import base64
import dataclasses
import datetime as dt
import hashlib
import json
import math
import os
import re
import signal
import socket
import ssl
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional, Union
from urllib.parse import unquote, urlsplit


VIDEO_CLOCK = 90_000
OPUS_CLOCK = 48_000
OPUS_FRAME_TICKS = 960
EXPECTED_TIMESTAMP_DELTAS = (2_970, 3_060)  # FLV 33/34 ms at 90 kHz.
DEFAULT_WALL_WARNING_MS = 40.0
DEFAULT_WALL_FAILURE_MS = 67.0
DEFAULT_WALL_GAP_MS = DEFAULT_WALL_FAILURE_MS  # Legacy hard-threshold name.
DEFAULT_AV_DRIFT_MS = 40.0
DEFAULT_ANOMALY_LIMIT = 32
DEFAULT_STARTUP_EXCLUSION_SECONDS = 10.0
USER_AGENT = "unifi-video-cadence-soak/2"
MAX_RTSP_BUFFER = 512 * 1024

ANOMALY_KINDS = (
    "invalid_rtp",
    "unexpected_payload_type",
    "ssrc_change",
    "sequence_gap",
    "sequence_duplicate",
    "sequence_reordered",
    "timestamp_duplicate",
    "timestamp_regression",
    "timestamp_delta_unexpected",
    "timestamp_gap_gt_40ms",
    "wall_gap_gt_threshold",
    "wall_gap_consecutive",
    "au_missing_marker",
    "au_empty",
    "au_without_vcl",
    "fu_invalid",
    "unsupported_packetization",
    "invalid_rtcp",
    "rtcp_sr_ssrc_mismatch",
)

AUDIO_ANOMALY_KINDS = (
    "invalid_rtp",
    "unexpected_payload_type",
    "ssrc_change",
    "sequence_gap",
    "sequence_duplicate",
    "sequence_reordered",
    "timestamp_duplicate",
    "timestamp_regression",
    "opus_timestamp_delta_unexpected",
    "opus_timestamp_gap_gt_40ms",
    "opus_wall_gap_gt_40ms",
    "opus_wall_gap_gt_threshold",
    "opus_wall_gap_consecutive",
    "opus_packet_invalid",
    "opus_packet_duration_unexpected",
    "opus_packet_stereo",
    "invalid_rtcp",
    "rtcp_sr_ssrc_mismatch",
)

VIDEO_STRUCTURAL_ANOMALIES = {
    "au_missing_marker",
    "au_empty",
    "au_without_vcl",
    "fu_invalid",
    "unsupported_packetization",
}
VIDEO_CADENCE_TRANSPORT_ANOMALIES = {
    "invalid_rtp",
    "unexpected_payload_type",
    "ssrc_change",
    "sequence_gap",
    "sequence_duplicate",
    "sequence_reordered",
    "timestamp_duplicate",
    "timestamp_regression",
    "timestamp_delta_unexpected",
    "timestamp_gap_gt_40ms",
    "wall_gap_gt_threshold",
    "wall_gap_consecutive",
}

VIDEO_WARNING_KINDS = ("wall_gap_warning",)
AUDIO_WARNING_KINDS = ("opus_wall_gap_warning",)

RTSP_URL_RE = re.compile(r"(?i)rtsps?://\S+")
READY_RE = re.compile(r"\bDS ([0-9A-F]{12}) (video[12]) ready (rtsps?://\S+)", re.I)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def safe_error(value: object, limit: int = 240) -> str:
    """Keep operational errors useful without persisting private RTSP URLs."""
    text = RTSP_URL_RE.sub("[redacted-rtsp]", str(value))
    return " ".join(text.split())[:limit]


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


@dataclasses.dataclass(frozen=True)
class RtpPacket:
    payload_type: int
    marker: bool
    sequence: int
    timestamp: int
    ssrc: int
    payload: bytes


def parse_rtp(packet: bytes) -> Optional[RtpPacket]:
    """Parse RTP v2, including CSRCs, an extension, and optional padding."""
    if len(packet) < 12 or packet[0] >> 6 != 2:
        return None
    csrc_count = packet[0] & 0x0F
    offset = 12 + 4 * csrc_count
    if offset > len(packet):
        return None
    if packet[0] & 0x10:
        if offset + 4 > len(packet):
            return None
        extension_words = int.from_bytes(packet[offset + 2:offset + 4], "big")
        offset += 4 + extension_words * 4
        if offset > len(packet):
            return None
    end = len(packet)
    if packet[0] & 0x20:
        padding = packet[-1]
        if not padding or padding > end - offset:
            return None
        end -= padding
    if offset >= end:
        return None
    return RtpPacket(
        payload_type=packet[1] & 0x7F,
        marker=bool(packet[1] & 0x80),
        sequence=int.from_bytes(packet[2:4], "big"),
        timestamp=int.from_bytes(packet[4:8], "big"),
        ssrc=int.from_bytes(packet[8:12], "big"),
        payload=packet[offset:end],
    )


@dataclasses.dataclass(frozen=True)
class RtcpSenderReport:
    ssrc: int
    ntp_seconds: float
    rtp_timestamp: int


def parse_rtcp_sender_reports(packet: bytes) -> Optional[list[RtcpSenderReport]]:
    """Parse every RFC 3550 Sender Report in one bounded compound RTCP packet."""
    reports: list[RtcpSenderReport] = []
    offset = 0
    while offset < len(packet):
        if len(packet) - offset < 4:
            return None
        first = packet[offset]
        if first >> 6 != 2:
            return None
        report_count = first & 0x1F
        packet_type = packet[offset + 1]
        size = (int.from_bytes(packet[offset + 2:offset + 4], "big") + 1) * 4
        if size < 4 or offset + size > len(packet):
            return None
        effective_size = size
        if first & 0x20:
            padding = packet[offset + size - 1]
            if not padding or padding > size - 4:
                return None
            effective_size -= padding
        if packet_type == 200:
            minimum = 28 + report_count * 24
            if effective_size < minimum:
                return None
            seconds = int.from_bytes(packet[offset + 8:offset + 12], "big")
            fraction = int.from_bytes(packet[offset + 12:offset + 16], "big")
            reports.append(RtcpSenderReport(
                ssrc=int.from_bytes(packet[offset + 4:offset + 8], "big"),
                ntp_seconds=seconds + fraction / 4_294_967_296.0,
                rtp_timestamp=int.from_bytes(packet[offset + 16:offset + 20], "big"),
            ))
        offset += size
    return reports


class RunningMetric:
    """O(1) count/min/max/mean accumulator."""

    def __init__(self) -> None:
        self.count = 0
        self.total = 0.0
        self.minimum: Optional[float] = None
        self.maximum: Optional[float] = None

    def add(self, value: float) -> None:
        self.count += 1
        self.total += value
        self.minimum = value if self.minimum is None else min(self.minimum, value)
        self.maximum = value if self.maximum is None else max(self.maximum, value)

    def snapshot(self, digits: int = 3) -> dict[str, Union[int, float, None]]:
        def rounded(value: Optional[float]) -> Optional[float]:
            return round(value, digits) if value is not None else None

        return {
            "samples": self.count,
            "min": rounded(self.minimum),
            "mean": rounded(self.total / self.count) if self.count else None,
            "max": rounded(self.maximum),
        }


class VideoCadenceAnalyzer:
    """Streaming, fixed-memory structural and cadence analysis for one RTP track."""

    def __init__(
        self,
        label: str,
        *,
        anomaly_limit: int = DEFAULT_ANOMALY_LIMIT,
        wall_gap_threshold_ms: float = DEFAULT_WALL_FAILURE_MS,
        wall_warning_threshold_ms: float = DEFAULT_WALL_WARNING_MS,
    ) -> None:
        if anomaly_limit < 1:
            raise ValueError("anomaly_limit must be positive")
        if wall_warning_threshold_ms > wall_gap_threshold_ms:
            raise ValueError("wall warning threshold must not exceed the failure threshold")
        self.label = label
        self.expected_payload_type = 96
        self.anomaly_limit = anomaly_limit
        self.wall_gap_threshold_ms = wall_gap_threshold_ms
        self.wall_warning_threshold_ms = wall_warning_threshold_ms
        self._lock = threading.Lock()
        self.start_ns: Optional[int] = None
        self.end_ns: Optional[int] = None
        self.active = False
        self.boundary_complete = False
        self.startup_packets = 0
        self.startup_boundary_aus = 0
        self.rtcp_packets = 0
        self.rtcp_sender_reports = 0
        self.rtp_packets = 0
        self.rtp_bytes = 0
        self.sequence_wraps = 0
        self.sequence_packets_missing = 0
        self.timestamp_wraps = 0
        self.aus_total = 0
        self.aus_clean = 0
        self.aus_with_violations = 0
        self.aus_malformed = 0
        self.aus_cadence_or_transport_violations = 0
        self.idr_aus = 0
        self.vcl_nals = 0
        self.anomaly_counts = {kind: 0 for kind in ANOMALY_KINDS}
        self.anomalies: deque[dict[str, Any]] = deque(maxlen=anomaly_limit)
        self.anomalies_total = 0
        self.warning_counts = {kind: 0 for kind in VIDEO_WARNING_KINDS}
        self.warnings: deque[dict[str, Any]] = deque(maxlen=anomaly_limit)
        self.warnings_total = 0
        self.timestamp_deltas = RunningMetric()
        self.wall_gaps_ms = RunningMetric()
        self.au_payload_bytes = RunningMetric()
        self.au_packet_counts = RunningMetric()
        self.timestamp_histogram = {
            "lt_2970": 0,
            "2970": 0,
            "2971_3059": 0,
            "3060": 0,
            "3061_3600": 0,
            "gt_3600": 0,
            "duplicate_or_regression": 0,
        }
        self.wall_histogram = {
            "le_20_ms": 0,
            "20_33_ms": 0,
            "33_34_ms": 0,
            "34_40_ms": 0,
            "40_67_ms": 0,
            "67_267_ms": 0,
            "gt_267_ms": 0,
        }
        self.ssrc: Optional[int] = None
        self.last_sequence: Optional[int] = None
        self.first_au_timestamp: Optional[int] = None
        self.last_au_timestamp: Optional[int] = None
        self.last_au_wall_ns: Optional[int] = None
        self.first_measured_wall_ns: Optional[int] = None
        self.last_measured_wall_ns: Optional[int] = None
        self.consecutive_wall_warnings = 0
        self.max_consecutive_wall_warnings = 0
        self._reset_current_au()

    def configure_window(self, start_ns: int, end_ns: int) -> None:
        if end_ns <= start_ns:
            raise ValueError("measurement window must have positive duration")
        with self._lock:
            self.start_ns = start_ns
            self.end_ns = end_ns

    def set_expected_payload_type(self, payload_type: int) -> None:
        if not 0 <= payload_type <= 127:
            raise ValueError("invalid RTP payload type")
        with self._lock:
            self.expected_payload_type = payload_type

    def note_rtcp(self) -> None:
        """Compatibility counter for callers that cannot supply RTCP bytes."""
        with self._lock:
            self.rtcp_packets += 1

    def consume_rtcp(self, raw: bytes, arrival_ns: int) -> list[RtcpSenderReport]:
        reports = parse_rtcp_sender_reports(raw)
        with self._lock:
            self.rtcp_packets += 1
            measured = (
                self.active
                and self.start_ns is not None
                and self.end_ns is not None
                and self.start_ns <= arrival_ns <= self.end_ns
            )
            if reports is None:
                if measured:
                    self._anomaly("invalid_rtcp", arrival_ns)
                return []
            for report in reports:
                if self.ssrc is not None and report.ssrc != self.ssrc:
                    if measured:
                        self._anomaly("rtcp_sr_ssrc_mismatch", arrival_ns)
                else:
                    self.rtcp_sender_reports += 1
            return reports

    def _reset_current_au(self) -> None:
        self.current_timestamp: Optional[int] = None
        self.current_packets = 0
        self.current_payload_bytes = 0
        self.current_has_vcl = False
        self.current_is_idr = False
        self.current_valid = True
        self.current_malformed = False
        self.current_cadence_or_transport_violation = False
        self.fu_open = False
        self.fu_type: Optional[int] = None
        self.fu_nri: Optional[int] = None

    def _anomaly(self, kind: str, at_ns: int, **details: Union[int, float, str]) -> None:
        if kind not in self.anomaly_counts:
            raise ValueError(f"unknown anomaly kind {kind}")
        if kind in VIDEO_STRUCTURAL_ANOMALIES:
            self.current_malformed = True
        elif kind in VIDEO_CADENCE_TRANSPORT_ANOMALIES:
            self.current_cadence_or_transport_violation = True
        self.anomaly_counts[kind] += 1
        self.anomalies_total += 1
        relative_ms = None
        if self.start_ns is not None:
            relative_ms = round((at_ns - self.start_ns) / 1_000_000, 3)
        self.anomalies.append({"kind": kind, "at_ms": relative_ms, **details})

    def _warning(self, kind: str, at_ns: int, **details: Union[int, float, str]) -> None:
        if kind not in self.warning_counts:
            raise ValueError(f"unknown warning kind {kind}")
        self.warning_counts[kind] += 1
        self.warnings_total += 1
        relative_ms = None
        if self.start_ns is not None:
            relative_ms = round((at_ns - self.start_ns) / 1_000_000, 3)
        self.warnings.append({"kind": kind, "at_ms": relative_ms, **details})

    def _timestamp_histogram_add(self, delta: Optional[int]) -> None:
        if delta is None:
            self.timestamp_histogram["duplicate_or_regression"] += 1
        elif delta < 2_970:
            self.timestamp_histogram["lt_2970"] += 1
        elif delta == 2_970:
            self.timestamp_histogram["2970"] += 1
        elif delta < 3_060:
            self.timestamp_histogram["2971_3059"] += 1
        elif delta == 3_060:
            self.timestamp_histogram["3060"] += 1
        elif delta <= 3_600:
            self.timestamp_histogram["3061_3600"] += 1
        else:
            self.timestamp_histogram["gt_3600"] += 1

    def _wall_histogram_add(self, value: float) -> None:
        if value <= 20:
            key = "le_20_ms"
        elif value <= 33:
            key = "20_33_ms"
        elif value <= 34:
            key = "33_34_ms"
        elif value <= 40:
            key = "34_40_ms"
        elif value <= 67:
            key = "40_67_ms"
        elif value <= 267:
            key = "67_267_ms"
        else:
            key = "gt_267_ms"
        self.wall_histogram[key] += 1

    def _sequence_check(self, packet: RtpPacket, at_ns: int) -> None:
        if self.ssrc is None:
            self.ssrc = packet.ssrc
        elif packet.ssrc != self.ssrc:
            self._anomaly("ssrc_change", at_ns)
            self.ssrc = packet.ssrc
            self.last_sequence = None
            self.last_au_timestamp = None
            self.last_au_wall_ns = None
            self.consecutive_wall_warnings = 0
            self.current_valid = False
        advance = True
        if self.last_sequence is not None:
            delta = (packet.sequence - self.last_sequence) & 0xFFFF
            if 0 < delta < 0x8000 and packet.sequence < self.last_sequence:
                self.sequence_wraps += 1
            if delta == 0:
                self._anomaly("sequence_duplicate", at_ns, sequence=packet.sequence)
                self.current_valid = False
                advance = False
            elif delta == 1:
                pass
            elif delta < 0x8000:
                self.sequence_packets_missing += delta - 1
                self._anomaly("sequence_gap", at_ns, missing=delta - 1)
                self.current_valid = False
            else:
                self._anomaly("sequence_reordered", at_ns, sequence=packet.sequence)
                self.current_valid = False
                advance = False
        # A duplicate or late packet is observed but cannot become the new
        # continuity baseline; doing so manufactures a gap on the next packet.
        if advance:
            self.last_sequence = packet.sequence

    def _start_au(self, timestamp: int) -> None:
        self._reset_current_au()
        self.current_timestamp = timestamp

    def _parse_h264_payload(self, payload: bytes, at_ns: int) -> None:
        if not payload:
            self._anomaly("au_empty", at_ns)
            self.current_valid = False
            return
        nal_type = payload[0] & 0x1F
        if 1 <= nal_type <= 23:
            if self.fu_open:
                self._anomaly("fu_invalid", at_ns, reason="single_nal_inside_fu")
                self.current_valid = False
                self.fu_open = False
            if nal_type in (1, 2, 3, 4, 5):
                self.current_has_vcl = True
                self.current_is_idr |= nal_type == 5
                self.vcl_nals += 1
            return
        if nal_type == 24:  # STAP-A
            if self.fu_open:
                self._anomaly("fu_invalid", at_ns, reason="stap_inside_fu")
                self.current_valid = False
                self.fu_open = False
            offset = 1
            units = 0
            while offset + 2 <= len(payload):
                length = int.from_bytes(payload[offset:offset + 2], "big")
                offset += 2
                if not length or offset + length > len(payload):
                    self._anomaly("unsupported_packetization", at_ns, reason="malformed_stap_a")
                    self.current_valid = False
                    return
                nested_type = payload[offset] & 0x1F
                if not 1 <= nested_type <= 23:
                    self._anomaly("unsupported_packetization", at_ns, reason="invalid_stap_nal")
                    self.current_valid = False
                    return
                if nested_type in (1, 2, 3, 4, 5):
                    self.current_has_vcl = True
                    self.current_is_idr |= nested_type == 5
                    self.vcl_nals += 1
                units += 1
                offset += length
            if not units or offset != len(payload):
                self._anomaly("unsupported_packetization", at_ns, reason="trailing_stap_bytes")
                self.current_valid = False
            return
        if nal_type == 28:  # FU-A
            if len(payload) < 3:
                self._anomaly("fu_invalid", at_ns, reason="short_fu_a")
                self.current_valid = False
                return
            fu_header = payload[1]
            start = bool(fu_header & 0x80)
            end = bool(fu_header & 0x40)
            original_type = fu_header & 0x1F
            nri = payload[0] & 0x60
            if not 1 <= original_type <= 23 or (fu_header & 0x20) or (start and end):
                self._anomaly("fu_invalid", at_ns, reason="invalid_fu_flags_or_type")
                self.current_valid = False
                return
            if start:
                if self.fu_open:
                    self._anomaly("fu_invalid", at_ns, reason="nested_fu_start")
                    self.current_valid = False
                self.fu_open = True
                self.fu_type = original_type
                self.fu_nri = nri
                if original_type in (1, 2, 3, 4, 5):
                    self.current_has_vcl = True
                    self.current_is_idr |= original_type == 5
                    self.vcl_nals += 1
                return
            if not self.fu_open:
                self._anomaly("fu_invalid", at_ns, reason="orphan_fu_fragment")
                self.current_valid = False
                return
            if original_type != self.fu_type or nri != self.fu_nri:
                self._anomaly("fu_invalid", at_ns, reason="fu_header_changed")
                self.current_valid = False
            if end:
                self.fu_open = False
                self.fu_type = None
                self.fu_nri = None
            return
        self._anomaly("unsupported_packetization", at_ns, nal_type=nal_type)
        self.current_valid = False

    def _finish_au(self, at_ns: int, marker: bool) -> None:
        if self.current_timestamp is None:
            return
        if not marker:
            self._anomaly("au_missing_marker", at_ns)
            self.current_valid = False
        if self.fu_open:
            self._anomaly("fu_invalid", at_ns, reason="unterminated_fu")
            self.current_valid = False
        if not self.current_has_vcl:
            self._anomaly("au_without_vcl", at_ns)
            self.current_valid = False

        if self.last_au_timestamp is not None:
            delta = (self.current_timestamp - self.last_au_timestamp) & 0xFFFFFFFF
            if delta == 0:
                self._timestamp_histogram_add(None)
                self._anomaly("timestamp_duplicate", at_ns)
                self.current_valid = False
            elif delta >= 0x80000000:
                self._timestamp_histogram_add(None)
                self._anomaly("timestamp_regression", at_ns, delta=delta)
                self.current_valid = False
            else:
                if self.current_timestamp < self.last_au_timestamp:
                    self.timestamp_wraps += 1
                self.timestamp_deltas.add(delta)
                self._timestamp_histogram_add(delta)
                if delta not in EXPECTED_TIMESTAMP_DELTAS:
                    self._anomaly("timestamp_delta_unexpected", at_ns, delta=delta)
                    self.current_valid = False
                if delta > int(VIDEO_CLOCK * 0.040):
                    self._anomaly("timestamp_gap_gt_40ms", at_ns, delta=delta)
                    self.current_valid = False
        if self.last_au_wall_ns is not None:
            wall_gap_ms = (at_ns - self.last_au_wall_ns) / 1_000_000
            self.wall_gaps_ms.add(wall_gap_ms)
            self._wall_histogram_add(wall_gap_ms)
            if wall_gap_ms > self.wall_gap_threshold_ms:
                self.consecutive_wall_warnings = 0
                self._anomaly(
                    "wall_gap_gt_threshold",
                    at_ns,
                    gap_ms=round(wall_gap_ms, 3),
                )
                self.current_valid = False
            elif wall_gap_ms > self.wall_warning_threshold_ms:
                self.consecutive_wall_warnings += 1
                self.max_consecutive_wall_warnings = max(
                    self.max_consecutive_wall_warnings,
                    self.consecutive_wall_warnings,
                )
                self._warning(
                    "wall_gap_warning",
                    at_ns,
                    gap_ms=round(wall_gap_ms, 3),
                )
                if self.consecutive_wall_warnings == 2:
                    self._anomaly(
                        "wall_gap_consecutive",
                        at_ns,
                        consecutive=self.consecutive_wall_warnings,
                        gap_ms=round(wall_gap_ms, 3),
                    )
                    self.current_valid = False
            else:
                self.consecutive_wall_warnings = 0

        self.aus_total += 1
        self.au_payload_bytes.add(self.current_payload_bytes)
        self.au_packet_counts.add(self.current_packets)
        if self.current_is_idr:
            self.idr_aus += 1
        if self.current_malformed:
            self.aus_malformed += 1
        if self.current_cadence_or_transport_violation:
            self.aus_cadence_or_transport_violations += 1
        if self.current_malformed or self.current_cadence_or_transport_violation:
            self.aus_with_violations += 1
        else:
            self.aus_clean += 1
        if self.first_au_timestamp is None:
            self.first_au_timestamp = self.current_timestamp
        self.last_au_timestamp = self.current_timestamp
        self.last_au_wall_ns = at_ns
        if self.first_measured_wall_ns is None:
            self.first_measured_wall_ns = at_ns
        self.last_measured_wall_ns = at_ns
        self._reset_current_au()

    def consume_rtp(self, raw: bytes, arrival_ns: int) -> bool:
        """Consume one RTP packet; return False once it is beyond the window."""
        with self._lock:
            if self.start_ns is None or self.end_ns is None:
                raise RuntimeError("measurement window is not configured")
            if arrival_ns > self.end_ns:
                # A partial boundary AU is excluded rather than called malformed.
                self.boundary_complete = True
                self._reset_current_au()
                return False
            packet = parse_rtp(raw)
            if not self.active:
                self.startup_packets += 1
                if (
                    arrival_ns >= self.start_ns
                    and packet is not None
                    and packet.payload_type == self.expected_payload_type
                    and packet.marker
                ):
                    # This complete AU is the baseline.  Measurement begins with
                    # its successor, so no partial replay AU can enter statistics.
                    self.active = True
                    self.startup_boundary_aus += 1
                    self.ssrc = packet.ssrc
                    self.last_sequence = packet.sequence
                    self.last_au_timestamp = packet.timestamp
                    self.last_au_wall_ns = arrival_ns
                    self.first_measured_wall_ns = arrival_ns
                    self.last_measured_wall_ns = arrival_ns
                return True
            if packet is None:
                self._anomaly("invalid_rtp", arrival_ns)
                self.current_valid = False
                return True
            if packet.payload_type != self.expected_payload_type:
                self._anomaly(
                    "unexpected_payload_type",
                    arrival_ns,
                    payload_type=packet.payload_type,
                )
                self.current_valid = False
                return True

            self.rtp_packets += 1
            self.rtp_bytes += len(raw)
            if self.current_timestamp is None:
                self._start_au(packet.timestamp)
            elif packet.timestamp != self.current_timestamp:
                self._finish_au(arrival_ns, marker=False)
                self._start_au(packet.timestamp)
            # Run the continuity check after selecting the destination AU.  A
            # sequence loss on the first packet of a new AU must mark that AU
            # invalid rather than being cleared by _start_au().
            self._sequence_check(packet, arrival_ns)
            self.current_packets += 1
            self.current_payload_bytes += len(packet.payload)
            self._parse_h264_payload(packet.payload, arrival_ns)
            if packet.marker:
                self._finish_au(arrival_ns, marker=True)
            return True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            coverage_seconds = None
            observed_fps = None
            if self.first_measured_wall_ns is not None and self.last_measured_wall_ns is not None:
                coverage_seconds = max(
                    0.0,
                    (self.last_measured_wall_ns - self.first_measured_wall_ns) / 1_000_000_000,
                )
                if coverage_seconds > 0:
                    observed_fps = self.aus_total / coverage_seconds
            return {
                "active": self.active,
                "boundary_complete": self.boundary_complete,
                "expected_payload_type": self.expected_payload_type,
                "startup_packets_excluded": self.startup_packets,
                "startup_boundary_aus_excluded": self.startup_boundary_aus,
                "rtcp_packets": self.rtcp_packets,
                "rtcp_sender_reports": self.rtcp_sender_reports,
                "rtp_packets": self.rtp_packets,
                "rtp_bytes": self.rtp_bytes,
                "sequence_wraps": self.sequence_wraps,
                "sequence_packets_missing": self.sequence_packets_missing,
                "timestamp_wraps": self.timestamp_wraps,
                "first_rtp_timestamp": self.first_au_timestamp,
                "last_rtp_timestamp": self.last_au_timestamp,
                "aus": {
                    "total": self.aus_total,
                    "clean": self.aus_clean,
                    "with_violations": self.aus_with_violations,
                    "malformed": self.aus_malformed,
                    "cadence_or_transport_violations": self.aus_cadence_or_transport_violations,
                    "idr": self.idr_aus,
                    "vcl_nals": self.vcl_nals,
                },
                "coverage_seconds": round(coverage_seconds, 3) if coverage_seconds is not None else None,
                "observed_fps": round(observed_fps, 6) if observed_fps is not None else None,
                "timestamp_delta_ticks": self.timestamp_deltas.snapshot(3),
                "timestamp_delta_histogram": dict(self.timestamp_histogram),
                "wall_gap_ms": self.wall_gaps_ms.snapshot(3),
                "wall_gap_histogram": dict(self.wall_histogram),
                "au_payload_bytes": self.au_payload_bytes.snapshot(1),
                "au_packet_counts": self.au_packet_counts.snapshot(3),
                "anomaly_counts": dict(self.anomaly_counts),
                "anomalies_total": self.anomalies_total,
                "anomalies_retained": len(self.anomalies),
                "anomalies_evicted": max(0, self.anomalies_total - len(self.anomalies)),
                "anomalies": list(self.anomalies),
                "warning_counts": dict(self.warning_counts),
                "warnings_total": self.warnings_total,
                "warnings_retained": len(self.warnings),
                "warnings_evicted": max(0, self.warnings_total - len(self.warnings)),
                "warnings": list(self.warnings),
                "wall_arrival": {
                    "warning_threshold_ms": self.wall_warning_threshold_ms,
                    "failure_threshold_ms": self.wall_gap_threshold_ms,
                    "consecutive_warning_limit": 2,
                    "max_consecutive_warnings": self.max_consecutive_wall_warnings,
                },
            }


@dataclasses.dataclass(frozen=True)
class AudioTrack:
    payload_type: int
    control: str
    codec: str
    clock_rate: int
    channels: int
    rtpmap_channels: int
    frame_duration_ms: Optional[float]


def opus_packet_duration_ms(payload: bytes) -> Optional[float]:
    """Return total RFC 6716 packet duration without decoding the payload."""
    if len(payload) < 2:
        return None
    config = payload[0] >> 3
    if config < 12:
        frame_duration = (10.0, 20.0, 40.0, 60.0)[config % 4]
    elif config < 16:
        frame_duration = (10.0, 20.0)[config % 2]
    else:
        frame_duration = (2.5, 5.0, 10.0, 20.0)[config % 4]
    frame_code = payload[0] & 0x03
    if frame_code == 0:
        frames = 1
    elif frame_code in (1, 2):
        frames = 2
    else:
        frames = payload[1] & 0x3F
        if not frames:
            return None
    duration = frame_duration * frames
    return duration if duration <= 120.0 else None


class AudioCadenceAnalyzer:
    """Fixed-memory RTP continuity and Opus profile analyzer."""

    def __init__(
        self,
        label: str,
        *,
        anomaly_limit: int = DEFAULT_ANOMALY_LIMIT,
        wall_gap_threshold_ms: float = DEFAULT_WALL_FAILURE_MS,
        wall_warning_threshold_ms: float = DEFAULT_WALL_WARNING_MS,
    ) -> None:
        if wall_warning_threshold_ms > wall_gap_threshold_ms:
            raise ValueError("wall warning threshold must not exceed the failure threshold")
        self.label = label
        self.anomaly_limit = anomaly_limit
        self.wall_gap_threshold_ms = wall_gap_threshold_ms
        self.wall_warning_threshold_ms = wall_warning_threshold_ms
        self._lock = threading.Lock()
        self.track: Optional[AudioTrack] = None
        self.start_ns: Optional[int] = None
        self.end_ns: Optional[int] = None
        self.active = False
        self.boundary_complete = False
        self.startup_packets = 0
        self.rtp_packets = 0
        self.rtp_bytes = 0
        self.packets_clean = 0
        self.packets_with_violations = 0
        self.rtcp_packets = 0
        self.rtcp_sender_reports = 0
        self.sequence_wraps = 0
        self.sequence_packets_missing = 0
        self.timestamp_wraps = 0
        self.ssrc: Optional[int] = None
        self.last_sequence: Optional[int] = None
        self.first_timestamp: Optional[int] = None
        self.last_timestamp: Optional[int] = None
        self.last_wall_ns: Optional[int] = None
        self.first_measured_wall_ns: Optional[int] = None
        self.last_measured_wall_ns: Optional[int] = None
        self.timestamp_deltas = RunningMetric()
        self.wall_gaps_ms = RunningMetric()
        self.payload_bytes = RunningMetric()
        self.anomaly_counts = {kind: 0 for kind in AUDIO_ANOMALY_KINDS}
        self.anomalies: deque[dict[str, Any]] = deque(maxlen=anomaly_limit)
        self.anomalies_total = 0
        self.warning_counts = {kind: 0 for kind in AUDIO_WARNING_KINDS}
        self.warnings: deque[dict[str, Any]] = deque(maxlen=anomaly_limit)
        self.warnings_total = 0
        self.consecutive_wall_warnings = 0
        self.max_consecutive_wall_warnings = 0

    def configure_track(self, track: AudioTrack) -> None:
        with self._lock:
            self.track = track

    def configure_window(self, start_ns: int, end_ns: int) -> None:
        if end_ns <= start_ns:
            raise ValueError("measurement window must have positive duration")
        with self._lock:
            self.start_ns = start_ns
            self.end_ns = end_ns

    def _anomaly(self, kind: str, at_ns: int, **details: Union[int, float, str]) -> None:
        if kind not in self.anomaly_counts:
            raise ValueError(f"unknown audio anomaly kind {kind}")
        self.anomaly_counts[kind] += 1
        self.anomalies_total += 1
        relative_ms = None
        if self.start_ns is not None:
            relative_ms = round((at_ns - self.start_ns) / 1_000_000, 3)
        self.anomalies.append({"kind": kind, "at_ms": relative_ms, **details})

    def _warning(self, kind: str, at_ns: int, **details: Union[int, float, str]) -> None:
        if kind not in self.warning_counts:
            raise ValueError(f"unknown audio warning kind {kind}")
        self.warning_counts[kind] += 1
        self.warnings_total += 1
        relative_ms = None
        if self.start_ns is not None:
            relative_ms = round((at_ns - self.start_ns) / 1_000_000, 3)
        self.warnings.append({"kind": kind, "at_ms": relative_ms, **details})

    def consume_rtcp(self, raw: bytes, arrival_ns: int) -> list[RtcpSenderReport]:
        reports = parse_rtcp_sender_reports(raw)
        with self._lock:
            self.rtcp_packets += 1
            measured = (
                self.active
                and self.start_ns is not None
                and self.end_ns is not None
                and self.start_ns <= arrival_ns <= self.end_ns
            )
            if reports is None:
                if measured:
                    self._anomaly("invalid_rtcp", arrival_ns)
                return []
            for report in reports:
                if self.ssrc is not None and report.ssrc != self.ssrc:
                    if measured:
                        self._anomaly("rtcp_sr_ssrc_mismatch", arrival_ns)
                else:
                    self.rtcp_sender_reports += 1
            return reports

    def _sequence_check(self, packet: RtpPacket, at_ns: int) -> bool:
        if self.ssrc is None:
            self.ssrc = packet.ssrc
        elif packet.ssrc != self.ssrc:
            self._anomaly("ssrc_change", at_ns)
            self.ssrc = packet.ssrc
            self.last_sequence = None
            self.last_timestamp = None
            self.last_wall_ns = None
            self.consecutive_wall_warnings = 0
        if self.last_sequence is None:
            self.last_sequence = packet.sequence
            return True
        delta = (packet.sequence - self.last_sequence) & 0xFFFF
        if delta == 0:
            self._anomaly("sequence_duplicate", at_ns, sequence=packet.sequence)
            return False
        if delta >= 0x8000:
            self._anomaly("sequence_reordered", at_ns, sequence=packet.sequence)
            return False
        if packet.sequence < self.last_sequence:
            self.sequence_wraps += 1
        if delta > 1:
            self.sequence_packets_missing += delta - 1
            self._anomaly("sequence_gap", at_ns, missing=delta - 1)
        self.last_sequence = packet.sequence
        return True

    def consume_rtp(self, raw: bytes, arrival_ns: int) -> bool:
        with self._lock:
            if self.track is None:
                raise RuntimeError("audio track is not configured")
            if self.start_ns is None or self.end_ns is None:
                raise RuntimeError("measurement window is not configured")
            if arrival_ns > self.end_ns:
                self.boundary_complete = True
                return False
            packet = parse_rtp(raw)
            if not self.active:
                self.startup_packets += 1
                if (
                    arrival_ns >= self.start_ns
                    and packet is not None
                    and packet.payload_type == self.track.payload_type
                ):
                    self.active = True
                    self.ssrc = packet.ssrc
                    self.last_sequence = packet.sequence
                    self.first_timestamp = packet.timestamp
                    self.last_timestamp = packet.timestamp
                    self.last_wall_ns = arrival_ns
                    self.first_measured_wall_ns = arrival_ns
                    self.last_measured_wall_ns = arrival_ns
                return True
            anomaly_start = self.anomalies_total
            self.rtp_packets += 1
            self.rtp_bytes += len(raw)
            if packet is None:
                self._anomaly("invalid_rtp", arrival_ns)
                self.packets_with_violations += 1
                return True
            if packet.payload_type != self.track.payload_type:
                self._anomaly(
                    "unexpected_payload_type",
                    arrival_ns,
                    payload_type=packet.payload_type,
                )
                self.packets_with_violations += 1
                return True

            self.payload_bytes.add(len(packet.payload))
            advance = self._sequence_check(packet, arrival_ns)
            if self.last_timestamp is not None:
                delta = (packet.timestamp - self.last_timestamp) & 0xFFFFFFFF
                if delta == 0:
                    self._anomaly("timestamp_duplicate", arrival_ns)
                elif delta >= 0x80000000:
                    self._anomaly("timestamp_regression", arrival_ns, delta=delta)
                else:
                    if packet.timestamp < self.last_timestamp:
                        self.timestamp_wraps += 1
                    self.timestamp_deltas.add(delta)
                    if self.track.codec == "opus" and delta != OPUS_FRAME_TICKS:
                        self._anomaly("opus_timestamp_delta_unexpected", arrival_ns, delta=delta)
                    if self.track.codec == "opus" and delta > OPUS_CLOCK * 0.040:
                        self._anomaly("opus_timestamp_gap_gt_40ms", arrival_ns, delta=delta)
            if self.last_wall_ns is not None:
                wall_gap_ms = (arrival_ns - self.last_wall_ns) / 1_000_000
                self.wall_gaps_ms.add(wall_gap_ms)
                if self.track.codec == "opus":
                    if wall_gap_ms > self.wall_gap_threshold_ms:
                        self.consecutive_wall_warnings = 0
                        self._anomaly(
                            "opus_wall_gap_gt_threshold",
                            arrival_ns,
                            gap_ms=round(wall_gap_ms, 3),
                        )
                    elif wall_gap_ms > self.wall_warning_threshold_ms:
                        self.consecutive_wall_warnings += 1
                        self.max_consecutive_wall_warnings = max(
                            self.max_consecutive_wall_warnings,
                            self.consecutive_wall_warnings,
                        )
                        self._warning(
                            "opus_wall_gap_warning",
                            arrival_ns,
                            gap_ms=round(wall_gap_ms, 3),
                        )
                        if self.consecutive_wall_warnings == 2:
                            self._anomaly(
                                "opus_wall_gap_consecutive",
                                arrival_ns,
                                consecutive=self.consecutive_wall_warnings,
                                gap_ms=round(wall_gap_ms, 3),
                            )
                    else:
                        self.consecutive_wall_warnings = 0
            if self.track.codec == "opus":
                duration = opus_packet_duration_ms(packet.payload)
                if duration is None:
                    self._anomaly("opus_packet_invalid", arrival_ns)
                elif duration != 20.0:
                    self._anomaly("opus_packet_duration_unexpected", arrival_ns, duration_ms=duration)
                if packet.payload[0] & 0x04:
                    self._anomaly("opus_packet_stereo", arrival_ns)

            if self.anomalies_total == anomaly_start:
                self.packets_clean += 1
            else:
                self.packets_with_violations += 1
            if advance:
                self.last_timestamp = packet.timestamp
                self.last_wall_ns = arrival_ns
                self.last_measured_wall_ns = arrival_ns
            return True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            coverage_seconds = None
            observed_packets_per_second = None
            if self.first_measured_wall_ns is not None and self.last_measured_wall_ns is not None:
                coverage_seconds = max(
                    0.0,
                    (self.last_measured_wall_ns - self.first_measured_wall_ns) / 1_000_000_000,
                )
                if coverage_seconds > 0:
                    observed_packets_per_second = self.rtp_packets / coverage_seconds
            profile = None
            if self.track is not None:
                profile = {
                    "codec": self.track.codec,
                    "payload_type": self.track.payload_type,
                    "clock_rate_hz": self.track.clock_rate,
                    "channels": self.track.channels,
                    "rtpmap_channels": self.track.rtpmap_channels,
                    "frame_duration_ms": self.track.frame_duration_ms,
                }
            return {
                "profile": profile,
                "active": self.active,
                "boundary_complete": self.boundary_complete,
                "startup_packets_excluded": self.startup_packets,
                "rtcp_packets": self.rtcp_packets,
                "rtcp_sender_reports": self.rtcp_sender_reports,
                "rtp_packets": self.rtp_packets,
                "rtp_bytes": self.rtp_bytes,
                "packets": {
                    "total": self.rtp_packets,
                    "clean": self.packets_clean,
                    "with_violations": self.packets_with_violations,
                },
                "sequence_wraps": self.sequence_wraps,
                "sequence_packets_missing": self.sequence_packets_missing,
                "timestamp_wraps": self.timestamp_wraps,
                "first_rtp_timestamp": self.first_timestamp,
                "last_rtp_timestamp": self.last_timestamp,
                "coverage_seconds": round(coverage_seconds, 3) if coverage_seconds is not None else None,
                "observed_packets_per_second": (
                    round(observed_packets_per_second, 6)
                    if observed_packets_per_second is not None else None
                ),
                "timestamp_delta_ticks": self.timestamp_deltas.snapshot(3),
                "wall_gap_ms": self.wall_gaps_ms.snapshot(3),
                "payload_bytes": self.payload_bytes.snapshot(1),
                "anomaly_counts": dict(self.anomaly_counts),
                "anomalies_total": self.anomalies_total,
                "anomalies_retained": len(self.anomalies),
                "anomalies_evicted": max(0, self.anomalies_total - len(self.anomalies)),
                "anomalies": list(self.anomalies),
                "warning_counts": dict(self.warning_counts),
                "warnings_total": self.warnings_total,
                "warnings_retained": len(self.warnings),
                "warnings_evicted": max(0, self.warnings_total - len(self.warnings)),
                "warnings": list(self.warnings),
                "wall_arrival": {
                    "warning_threshold_ms": self.wall_warning_threshold_ms,
                    "failure_threshold_ms": self.wall_gap_threshold_ms,
                    "consecutive_warning_limit": 2,
                    "max_consecutive_warnings": self.max_consecutive_wall_warnings,
                },
            }


class AvSyncAnalyzer:
    """Compare video/audio media heads only through RFC 3550 SR mappings."""

    def __init__(self, *, anomaly_limit: int, threshold_ms: float = DEFAULT_AV_DRIFT_MS) -> None:
        self._lock = threading.Lock()
        self.anomaly_limit = anomaly_limit
        self.threshold_ms = threshold_ms
        self.start_ns: Optional[int] = None
        self.end_ns: Optional[int] = None
        self.audio_clock = OPUS_CLOCK
        self.latest: dict[str, Optional[tuple[int, int, int]]] = {
            "video": None,
            "audio": None,
        }
        self.mapping: dict[str, Optional[RtcpSenderReport]] = {
            "video": None,
            "audio": None,
        }
        self.last_sample_key: Optional[tuple[Any, ...]] = None
        self.mappings_available = False
        self.drift_ms = RunningMetric()
        self.absolute_drift_ms = RunningMetric()
        self.drift_over_threshold = 0
        self.anomalies: deque[dict[str, Any]] = deque(maxlen=anomaly_limit)

    def configure_audio(self, track: AudioTrack) -> None:
        with self._lock:
            self.audio_clock = track.clock_rate

    def configure_window(self, start_ns: int, end_ns: int) -> None:
        with self._lock:
            self.start_ns = start_ns
            self.end_ns = end_ns

    @staticmethod
    def _mapped_ntp(report: RtcpSenderReport, timestamp: int, clock_rate: int) -> float:
        delta = (timestamp - report.rtp_timestamp) & 0xFFFFFFFF
        if delta >= 0x80000000:
            delta -= 0x100000000
        return report.ntp_seconds + delta / clock_rate

    def _compute(self, at_ns: int) -> None:
        if self.start_ns is None or self.end_ns is None:
            return
        if at_ns < self.start_ns or at_ns > self.end_ns:
            return
        video = self.latest["video"]
        audio = self.latest["audio"]
        video_sr = self.mapping["video"]
        audio_sr = self.mapping["audio"]
        if video is None or audio is None or video_sr is None or audio_sr is None:
            return
        if video[2] < self.start_ns or audio[2] < self.start_ns:
            return
        if video_sr.ssrc != video[0] or audio_sr.ssrc != audio[0]:
            return
        key = (
            video[0], video[1], audio[0], audio[1],
            video_sr.ntp_seconds, video_sr.rtp_timestamp,
            audio_sr.ntp_seconds, audio_sr.rtp_timestamp,
        )
        if key == self.last_sample_key:
            return
        self.last_sample_key = key
        self.mappings_available = True
        video_ntp = self._mapped_ntp(video_sr, video[1], VIDEO_CLOCK)
        audio_ntp = self._mapped_ntp(audio_sr, audio[1], self.audio_clock)
        drift_ms = (audio_ntp - video_ntp) * 1000.0
        absolute = abs(drift_ms)
        self.drift_ms.add(drift_ms)
        self.absolute_drift_ms.add(absolute)
        if absolute > self.threshold_ms:
            self.drift_over_threshold += 1
            relative_ms = round((at_ns - self.start_ns) / 1_000_000, 3)
            self.anomalies.append({
                "kind": "av_drift_gt_40ms",
                "at_ms": relative_ms,
                "drift_ms": round(drift_ms, 3),
            })

    def note_rtp(self, track: str, packet: RtpPacket, arrival_ns: int) -> None:
        with self._lock:
            self.latest[track] = (packet.ssrc, packet.timestamp, arrival_ns)
            self._compute(arrival_ns)

    def note_sender_reports(
        self,
        track: str,
        reports: list[RtcpSenderReport],
        arrival_ns: int,
    ) -> None:
        with self._lock:
            latest = self.latest[track]
            selected = None
            for report in reports:
                if latest is None or report.ssrc == latest[0]:
                    selected = report
            if selected is not None:
                self.mapping[track] = selected
                self._compute(arrival_ns)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            retained = len(self.anomalies)
            return {
                "method": "rtcp_sender_report_ntp_rtp_mapping",
                "threshold_ms": self.threshold_ms,
                "standards_compliant_mappings_observed": self.mappings_available,
                "samples": self.drift_ms.count,
                "drift_ms": self.drift_ms.snapshot(3),
                "absolute_drift_ms": self.absolute_drift_ms.snapshot(3),
                "drift_over_threshold": self.drift_over_threshold,
                "anomalies_total": self.drift_over_threshold,
                "anomalies_retained": retained,
                "anomalies_evicted": max(0, self.drift_over_threshold - retained),
                "anomalies": list(self.anomalies),
            }


class StreamCadenceAnalyzer:
    """One bounded video/audio/A-V analysis unit for an RTSP presentation."""

    def __init__(
        self,
        label: str,
        *,
        anomaly_limit: int,
        wall_gap_threshold_ms: float,
        wall_warning_threshold_ms: float = DEFAULT_WALL_WARNING_MS,
    ) -> None:
        self.video = VideoCadenceAnalyzer(
            label,
            anomaly_limit=anomaly_limit,
            wall_gap_threshold_ms=wall_gap_threshold_ms,
            wall_warning_threshold_ms=wall_warning_threshold_ms,
        )
        self.audio = AudioCadenceAnalyzer(
            label,
            anomaly_limit=anomaly_limit,
            wall_gap_threshold_ms=wall_gap_threshold_ms,
            wall_warning_threshold_ms=wall_warning_threshold_ms,
        )
        self.av_sync = AvSyncAnalyzer(anomaly_limit=anomaly_limit)

    def configure_audio(self, track: AudioTrack) -> None:
        self.audio.configure_track(track)
        self.av_sync.configure_audio(track)

    def configure_window(self, start_ns: int, end_ns: int) -> None:
        self.video.configure_window(start_ns, end_ns)
        self.audio.configure_window(start_ns, end_ns)
        self.av_sync.configure_window(start_ns, end_ns)

    def set_video_payload_type(self, payload_type: int) -> None:
        self.video.set_expected_payload_type(payload_type)

    def consume_video_rtp(self, raw: bytes, arrival_ns: int) -> bool:
        packet = parse_rtp(raw)
        keep_going = self.video.consume_rtp(raw, arrival_ns)
        if packet is not None and packet.payload_type == self.video.expected_payload_type and packet.marker:
            self.av_sync.note_rtp("video", packet, arrival_ns)
        return keep_going

    def consume_audio_rtp(self, raw: bytes, arrival_ns: int) -> bool:
        packet = parse_rtp(raw)
        keep_going = self.audio.consume_rtp(raw, arrival_ns)
        if (
            packet is not None
            and self.audio.track is not None
            and packet.payload_type == self.audio.track.payload_type
        ):
            self.av_sync.note_rtp("audio", packet, arrival_ns)
        return keep_going

    def consume_video_rtcp(self, raw: bytes, arrival_ns: int) -> None:
        reports = self.video.consume_rtcp(raw, arrival_ns)
        self.av_sync.note_sender_reports("video", reports, arrival_ns)

    def consume_audio_rtcp(self, raw: bytes, arrival_ns: int) -> None:
        reports = self.audio.consume_rtcp(raw, arrival_ns)
        self.av_sync.note_sender_reports("audio", reports, arrival_ns)

    def snapshot(self) -> dict[str, Any]:
        # Preserve the schema-1 video fields at the stream root so existing
        # cadence consumers keep working; schema 2 adds bounded audio/A-V
        # sections without weakening or relocating any video gate.
        result = self.video.snapshot()
        result["audio"] = self.audio.snapshot()
        result["av_sync"] = self.av_sync.snapshot()
        return result


@dataclasses.dataclass(frozen=True)
class RtspResponse:
    status: int
    headers: dict[str, str]
    body: bytes


@dataclasses.dataclass(frozen=True)
class ParsedRtspUrl:
    scheme: str
    host: str
    port: int
    request_url: str
    authorization: Optional[str]


def parse_rtsp_url(raw_url: str) -> ParsedRtspUrl:
    parsed = urlsplit(raw_url)
    if parsed.scheme not in ("rtsp", "rtsps") or not parsed.hostname:
        raise ValueError("source must be an rtsp:// or rtsps:// URL")
    port = parsed.port or (322 if parsed.scheme == "rtsps" else 554)
    host_for_url = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    request_url = f"{parsed.scheme}://{host_for_url}:{port}{parsed.path or '/'}"
    if parsed.query:
        request_url += "?" + parsed.query
    authorization = None
    if parsed.username is not None:
        credentials = f"{unquote(parsed.username)}:{unquote(parsed.password or '')}".encode()
        authorization = "Basic " + base64.b64encode(credentials).decode("ascii")
    return ParsedRtspUrl(parsed.scheme, parsed.hostname, port, request_url, authorization)


@dataclasses.dataclass(frozen=True)
class SdpTracks:
    video_payload_type: int
    video_control: str
    audio: AudioTrack


def _fmtp_parameters(value: str) -> dict[str, str]:
    parameters: dict[str, str] = {}
    for item in value.split(";"):
        key, separator, parameter = item.strip().partition("=")
        if key:
            parameters[key.lower()] = parameter.strip() if separator else ""
    return parameters


def parse_sdp_tracks(sdp: str) -> SdpTracks:
    """Select H.264 plus preferred Opus (or explicit AAC) media sections."""
    sections: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None
    for raw_line in sdp.replace("\r", "").split("\n"):
        line = raw_line.strip()
        if line.startswith("m="):
            fields = line[2:].split()
            payloads: list[int] = []
            for field in fields[3:]:
                try:
                    payloads.append(int(field))
                except ValueError:
                    pass
            current = {
                "media": fields[0].lower() if fields else "",
                "payloads": payloads,
                "rtpmap": {},
                "fmtp": {},
                "control": None,
                "ptime": None,
            }
            sections.append(current)
            continue
        if current is None:
            continue
        mapping = re.match(
            r"a=rtpmap:(\d+)\s+([^/\s]+)/([0-9]+)(?:/([0-9]+))?(?:\s|$)",
            line,
            re.I,
        )
        if mapping:
            current["rtpmap"][int(mapping.group(1))] = (
                mapping.group(2).lower(),
                int(mapping.group(3)),
                int(mapping.group(4) or "1"),
            )
            continue
        fmtp = re.match(r"a=fmtp:(\d+)\s+(.+)$", line, re.I)
        if fmtp:
            current["fmtp"][int(fmtp.group(1))] = _fmtp_parameters(fmtp.group(2))
            continue
        if line.lower().startswith("a=control:"):
            current["control"] = line.split(":", 1)[1].strip()
            continue
        ptime = re.match(r"a=ptime:([0-9]+(?:\.[0-9]+)?)$", line, re.I)
        if ptime:
            current["ptime"] = float(ptime.group(1))

    video_payload_type = None
    video_control = None
    for section in sections:
        if section["media"] != "video" or not section["control"]:
            continue
        for payload_type in section["payloads"]:
            mapping = section["rtpmap"].get(payload_type)
            if mapping and mapping[0] == "h264" and mapping[1] == VIDEO_CLOCK:
                video_payload_type = payload_type
                video_control = section["control"]
                break
        if video_payload_type is not None:
            break
    if video_payload_type is None or not video_control:
        raise ValueError("SDP has no H264/90000 video track with a control attribute")

    opus_candidates: list[tuple[dict[str, Any], int, tuple[str, int, int]]] = []
    aac_candidates: list[tuple[dict[str, Any], int, tuple[str, int, int]]] = []
    for section in sections:
        if section["media"] != "audio" or not section["control"]:
            continue
        for payload_type in section["payloads"]:
            mapping = section["rtpmap"].get(payload_type)
            if not mapping:
                continue
            if mapping[0] == "opus":
                opus_candidates.append((section, payload_type, mapping))
            elif mapping[0] in ("mpeg4-generic", "mp4a-latm", "aac"):
                aac_candidates.append((section, payload_type, mapping))

    opus_errors: list[str] = []
    for section, payload_type, mapping in opus_candidates:
        _, clock_rate, rtpmap_channels = mapping
        fmtp = section["fmtp"].get(payload_type, {})
        if clock_rate != OPUS_CLOCK:
            opus_errors.append("Opus RTP clock is not 48000 Hz")
            continue
        # RFC 7587 always uses /2 in rtpmap. Mono is negotiated through the
        # stereo/sprop-stereo parameters, whose defaults are both zero.
        if rtpmap_channels != 2:
            opus_errors.append("Opus rtpmap is not standards-compliant /2")
            continue
        if fmtp.get("stereo", "0") != "0" or fmtp.get("sprop-stereo", "0") != "0":
            opus_errors.append("Opus track is advertised as stereo")
            continue
        ptime = section["ptime"]
        if ptime is not None and ptime != 20.0:
            opus_errors.append("Opus ptime is not 20 ms")
            continue
        return SdpTracks(
            video_payload_type=video_payload_type,
            video_control=video_control,
            audio=AudioTrack(
                payload_type=payload_type,
                control=section["control"],
                codec="opus",
                clock_rate=clock_rate,
                channels=1,
                rtpmap_channels=rtpmap_channels,
                frame_duration_ms=ptime,
            ),
        )
    if opus_candidates:
        raise ValueError(opus_errors[0] if opus_errors else "invalid Opus audio track")

    if aac_candidates:
        section, payload_type, mapping = aac_candidates[0]
        _, clock_rate, channels = mapping
        if clock_rate <= 0 or channels <= 0:
            raise ValueError("invalid AAC audio rtpmap")
        return SdpTracks(
            video_payload_type=video_payload_type,
            video_control=video_control,
            audio=AudioTrack(
                payload_type=payload_type,
                control=section["control"],
                codec="aac",
                clock_rate=clock_rate,
                channels=channels,
                rtpmap_channels=channels,
                frame_duration_ms=section["ptime"],
            ),
        )
    raise ValueError("SDP has no supported Opus or AAC audio track with a control attribute")


def parse_video_sdp(sdp: str) -> tuple[int, str]:
    """Compatibility helper that does not require an audio section."""
    current_media: Optional[str] = None
    video_payloads: list[int] = []
    h264_payloads: set[int] = set()
    video_control: Optional[str] = None
    for raw_line in sdp.replace("\r", "").split("\n"):
        line = raw_line.strip()
        if line.startswith("m="):
            fields = line[2:].split()
            current_media = fields[0].lower() if fields else None
            if current_media == "video":
                for field in fields[3:]:
                    try:
                        video_payloads.append(int(field))
                    except ValueError:
                        pass
            continue
        if current_media != "video":
            continue
        match = re.match(r"a=rtpmap:(\d+)\s+H264/90000(?:\s|$)", line, re.I)
        if match:
            h264_payloads.add(int(match.group(1)))
        elif line.lower().startswith("a=control:"):
            video_control = line.split(":", 1)[1].strip()
    payload_type = next((pt for pt in video_payloads if pt in h264_payloads), None)
    if payload_type is None or not video_control:
        raise ValueError("SDP has no H264/90000 video track with a control attribute")
    return payload_type, video_control


def control_url(base_url: str, control: str) -> str:
    if control.lower().startswith(("rtsp://", "rtsps://")):
        return control
    if control == "*":
        return base_url
    if control.startswith("/"):
        parsed = urlsplit(base_url)
        host = f"[{parsed.hostname}]" if parsed.hostname and ":" in parsed.hostname else parsed.hostname
        return f"{parsed.scheme}://{host}:{parsed.port or 554}{control}"
    return base_url.rstrip("/") + "/" + control


class RtspInterleavedClient:
    """Small RTSP-over-TCP A/V client; contains no persistence or URL logging."""

    def __init__(
        self,
        raw_url: str,
        *,
        timeout: float,
        keepalive_interval: float,
        insecure_tls: bool,
    ) -> None:
        self.parsed = parse_rtsp_url(raw_url)
        self.timeout = timeout
        self.keepalive_interval = keepalive_interval
        self.insecure_tls = insecure_tls
        self.sock: Optional[socket.socket] = None
        self.buffer = bytearray()
        self.cseq = 0
        self.session: Optional[str] = None
        self.video_channel = 0
        self.video_rtcp_channel = 1
        self.rtcp_channel = 1  # compatibility alias
        self.audio_channel = 2
        self.audio_rtcp_channel = 3
        self.payload_type = 96
        self.audio_track: Optional[AudioTrack] = None
        self.play_url = self.parsed.request_url
        self.last_keepalive = 0.0

    def _send_request(self, method: str, url: str, headers: Optional[list[str]] = None) -> None:
        if self.sock is None:
            raise RuntimeError("RTSP socket is not connected")
        self.cseq += 1
        lines = [f"{method} {url} RTSP/1.0", f"CSeq: {self.cseq}", f"User-Agent: {USER_AGENT}"]
        if self.parsed.authorization:
            lines.append("Authorization: " + self.parsed.authorization)
        if self.session:
            lines.append("Session: " + self.session)
        lines.extend(headers or [])
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))

    @staticmethod
    def _extract_response(buffer: bytearray) -> Optional[RtspResponse]:
        end = buffer.find(b"\r\n\r\n")
        if end < 0:
            return None
        header = bytes(buffer[:end]).decode("iso-8859-1", errors="replace")
        lines = header.split("\r\n")
        match = re.match(r"RTSP/\d\.\d\s+(\d{3})", lines[0])
        if not match:
            raise ValueError("invalid RTSP response status line")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        try:
            content_length = int(headers.get("content-length", "0"))
        except ValueError as error:
            raise ValueError("invalid RTSP content length") from error
        if content_length < 0 or content_length > MAX_RTSP_BUFFER:
            raise ValueError("RTSP response body exceeds the bounded receive limit")
        total = end + 4 + content_length
        if len(buffer) < total:
            return None
        body = bytes(buffer[end + 4:total])
        del buffer[:total]
        return RtspResponse(int(match.group(1)), headers, body)

    def _read_response(self) -> RtspResponse:
        if self.sock is None:
            raise RuntimeError("RTSP socket is not connected")
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self.buffer and self.buffer[0] == 0x24:
                if len(self.buffer) >= 4:
                    length = int.from_bytes(self.buffer[2:4], "big")
                    if len(self.buffer) >= 4 + length:
                        # Bootstrap RTP preceding a response is intentionally not
                        # measured; the shared startup window excludes it anyway.
                        del self.buffer[:4 + length]
                        continue
            elif self.buffer:
                response = self._extract_response(self.buffer)
                if response is not None:
                    return response
            self.sock.settimeout(max(0.1, deadline - time.monotonic()))
            chunk = self.sock.recv(64 * 1024)
            if not chunk:
                raise ConnectionError("RTSP server closed during handshake")
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_RTSP_BUFFER:
                raise ValueError("RTSP handshake buffer exceeds the bounded receive limit")
        raise TimeoutError("timed out waiting for RTSP response")

    @staticmethod
    def _require_ok(response: RtspResponse, method: str) -> None:
        if response.status == 401:
            raise PermissionError(f"RTSP {method} authentication failed or requires Digest auth")
        if not 200 <= response.status < 300:
            raise RuntimeError(f"RTSP {method} returned status {response.status}")

    def _setup_track(self, track_url: str, first_channel: int) -> tuple[int, int]:
        self._send_request(
            "SETUP",
            track_url,
            [f"Transport: RTP/AVP/TCP;unicast;interleaved={first_channel}-{first_channel + 1}"],
        )
        setup = self._read_response()
        self._require_ok(setup, "SETUP")
        response_session = setup.headers.get("session", "").split(";", 1)[0].strip()
        if self.session is None:
            if not response_session:
                raise ValueError("RTSP SETUP omitted Session")
            self.session = response_session
        elif response_session and response_session != self.session:
            raise ValueError("RTSP SETUP changed Session between media tracks")
        channels = re.search(r"interleaved=(\d+)-(\d+)", setup.headers.get("transport", ""), re.I)
        selected = (
            (int(channels.group(1)), int(channels.group(2)))
            if channels else (first_channel, first_channel + 1)
        )
        if not all(0 <= channel <= 255 for channel in selected) or selected[0] == selected[1]:
            raise ValueError("RTSP SETUP returned invalid interleaved channels")
        return selected

    def open(self) -> None:
        raw_socket = socket.create_connection(
            (self.parsed.host, self.parsed.port),
            timeout=self.timeout,
        )
        if self.parsed.scheme == "rtsps":
            context = ssl.create_default_context()
            if self.insecure_tls:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            raw_socket = context.wrap_socket(raw_socket, server_hostname=self.parsed.host)
        self.sock = raw_socket
        self.sock.settimeout(self.timeout)

        self._send_request("DESCRIBE", self.parsed.request_url, ["Accept: application/sdp"])
        describe = self._read_response()
        self._require_ok(describe, "DESCRIBE")
        tracks = parse_sdp_tracks(describe.body.decode("utf-8", errors="replace"))
        self.payload_type = tracks.video_payload_type
        self.audio_track = tracks.audio
        self.play_url = describe.headers.get("content-base", self.parsed.request_url).rstrip("/")
        self.video_channel, self.video_rtcp_channel = self._setup_track(
            control_url(self.play_url, tracks.video_control),
            0,
        )
        self.rtcp_channel = self.video_rtcp_channel
        self.audio_channel, self.audio_rtcp_channel = self._setup_track(
            control_url(self.play_url, tracks.audio.control),
            2,
        )
        channels = {
            self.video_channel,
            self.video_rtcp_channel,
            self.audio_channel,
            self.audio_rtcp_channel,
        }
        if len(channels) != 4:
            raise ValueError("RTSP media tracks returned overlapping interleaved channels")

        self._send_request("PLAY", self.play_url)
        play = self._read_response()
        self._require_ok(play, "PLAY")
        self.last_keepalive = time.monotonic()
        self.sock.settimeout(0.5)

    def send_keepalive(self) -> None:
        if time.monotonic() - self.last_keepalive < self.keepalive_interval:
            return
        self._send_request("GET_PARAMETER", self.play_url)
        self.last_keepalive = time.monotonic()

    def close(self) -> None:
        sock, self.sock = self.sock, None
        if sock is None:
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass


class StreamWorker(threading.Thread):
    def __init__(
        self,
        label: str,
        raw_url: str,
        analyzer: StreamCadenceAnalyzer,
        ready: threading.Event,
        begin: threading.Event,
        stop: threading.Event,
        *,
        timeout: float,
        keepalive_interval: float,
        insecure_tls: bool,
    ) -> None:
        super().__init__(name=f"cadence-{label}", daemon=True)
        self.label = label
        self.client = RtspInterleavedClient(
            raw_url,
            timeout=timeout,
            keepalive_interval=keepalive_interval,
            insecure_tls=insecure_tls,
        )
        self.analyzer = analyzer
        self.ready = ready
        self.begin = begin
        self.stop_event = stop
        self.error: Optional[str] = None
        self.opened = False

    def _consume_buffer(self, arrival_ns: int) -> None:
        buffer = self.client.buffer
        if len(buffer) > MAX_RTSP_BUFFER:
            raise ValueError("RTSP stream buffer exceeds the bounded receive limit")
        offset = 0
        while offset < len(buffer):
            if buffer[offset] == 0x24:
                if len(buffer) - offset < 4:
                    break
                length = int.from_bytes(buffer[offset + 2:offset + 4], "big")
                if len(buffer) - offset < 4 + length:
                    break
                channel = buffer[offset + 1]
                payload = bytes(buffer[offset + 4:offset + 4 + length])
                offset += 4 + length
                if channel == self.client.video_channel:
                    self.analyzer.consume_video_rtp(payload, arrival_ns)
                elif channel == self.client.video_rtcp_channel:
                    self.analyzer.consume_video_rtcp(payload, arrival_ns)
                elif channel == self.client.audio_channel:
                    self.analyzer.consume_audio_rtp(payload, arrival_ns)
                elif channel == self.client.audio_rtcp_channel:
                    self.analyzer.consume_audio_rtcp(payload, arrival_ns)
                continue
            # RTSP keepalive responses are rare.  Compact the RTP prefix once,
            # then let the handshake parser consume the complete text response.
            if offset:
                del buffer[:offset]
                offset = 0
            response = RtspInterleavedClient._extract_response(buffer)
            if response is None:
                # A complete non-interleaved prefix that is not an RTSP response
                # is corruption; a partial "RTSP/" prefix simply needs more data.
                if len(buffer) > 8 and not bytes(buffer[:5]).startswith(b"RTSP/"):
                    raise ValueError("invalid RTSP/interleaved stream framing")
                break
        if offset:
            del buffer[:offset]

    def run(self) -> None:
        try:
            self.client.open()
            self.opened = True
            if self.client.audio_track is None:
                raise ValueError("RTSP setup completed without an audio track")
            self.analyzer.set_video_payload_type(self.client.payload_type)
            self.analyzer.configure_audio(self.client.audio_track)
            self.ready.set()
            while not self.begin.wait(0.1):
                if self.stop_event.is_set():
                    return
            while not self.stop_event.is_set():
                self.client.send_keepalive()
                try:
                    assert self.client.sock is not None
                    chunk = self.client.sock.recv(256 * 1024)
                except socket.timeout:
                    continue
                except OSError:
                    if self.stop_event.is_set():
                        return
                    raise
                if not chunk:
                    if self.stop_event.is_set():
                        return
                    raise ConnectionError("RTSP stream closed before the measurement ended")
                arrival_ns = time.monotonic_ns()
                self.client.buffer.extend(chunk)
                self._consume_buffer(arrival_ns)
        except Exception as error:
            if not self.stop_event.is_set():
                self.error = safe_error(error)
                self.stop_event.set()
            self.ready.set()
        finally:
            self.client.close()


def evaluate_stream(
    result: dict[str, Any],
    *,
    requested_seconds: float,
    minimum_fps: float,
    maximum_fps: float,
) -> list[str]:
    failures: list[str] = []
    video = result.get("video", result)
    if not video["active"]:
        failures.append("never reached a complete post-startup AU")
    if video["aus"]["total"] < 2:
        failures.append("too few measured access units")
    if video["aus"]["malformed"]:
        failures.append(f'{video["aus"]["malformed"]} structurally malformed access units')
    if video["aus"]["cadence_or_transport_violations"]:
        failures.append(
            f'{video["aus"]["cadence_or_transport_violations"]} access units with cadence/transport violations'
        )
    for kind, count in video["anomaly_counts"].items():
        if count:
            failures.append(f"{kind}={count}")
    coverage = video.get("coverage_seconds")
    # The baseline and trailing AU can each lie one frame inside the wall-clock
    # boundary.  200 ms is generous to scheduler quantization but cannot hide a
    # cadence omission, which is independently gated at 40 ms.
    if coverage is None or coverage < max(0.0, requested_seconds - 0.2):
        failures.append(f"insufficient continuous coverage ({coverage})")
    fps = video.get("observed_fps")
    if fps is None or not minimum_fps <= fps <= maximum_fps:
        failures.append(f"observed fps outside {minimum_fps}..{maximum_fps} ({fps})")

    audio = result.get("audio")
    if audio is not None:
        profile = audio.get("profile")
        if profile is None:
            failures.append("audio track profile was not configured")
        elif (
            profile.get("codec") != "opus"
            or profile.get("clock_rate_hz") != OPUS_CLOCK
            or profile.get("channels") != 1
            or profile.get("rtpmap_channels") != 2
            or profile.get("frame_duration_ms") != 20.0
        ):
            failures.append(
                "audio track is not advertised as standards-compliant mono "
                "Opus/48000 with 20 ms frames"
            )
        if not audio["active"]:
            failures.append("audio never reached the measurement window")
        if audio["packets"]["total"] < 2:
            failures.append("too few measured audio RTP packets")
        for kind, count in audio["anomaly_counts"].items():
            if count:
                failures.append(f"audio {kind}={count}")
        audio_coverage = audio.get("coverage_seconds")
        if audio_coverage is None or audio_coverage < max(0.0, requested_seconds - 0.2):
            failures.append(f"insufficient continuous audio coverage ({audio_coverage})")

    av_sync = result.get("av_sync")
    if av_sync is not None:
        if not av_sync["standards_compliant_mappings_observed"]:
            failures.append("no standards-compliant RTCP Sender Report A/V mapping was observed")
        elif av_sync["samples"] < 1:
            failures.append("RTCP Sender Report mappings produced no A/V samples")
        if av_sync["drift_over_threshold"]:
            failures.append(
                f'RTCP-mapped A/V drift over {av_sync["threshold_ms"]}ms='
                f'{av_sync["drift_over_threshold"]}'
            )
    return failures


def evaluate_stream_warnings(result: dict[str, Any]) -> list[str]:
    """Return informational receiver-timing warnings without weakening hard gates."""
    warnings: list[str] = []
    video = result.get("video", result)
    for kind, count in video.get("warning_counts", {}).items():
        if count:
            warnings.append(f"{kind}={count}")
    audio = result.get("audio")
    if audio is not None:
        for kind, count in audio.get("warning_counts", {}).items():
            if count:
                warnings.append(f"audio {kind}={count}")
    return warnings


def build_report(
    analyzers: dict[str, StreamCadenceAnalyzer],
    workers: dict[str, StreamWorker],
    *,
    started_at: str,
    measurement_start_ns: int,
    measurement_end_ns: int,
    requested_seconds: float,
    startup_exclusion_seconds: float,
    minimum_fps: float,
    maximum_fps: float,
    reached_deadline: bool,
    interrupted: bool,
    provenance: dict[str, Optional[str]],
) -> dict[str, Any]:
    streams = {label: analyzer.snapshot() for label, analyzer in analyzers.items()}
    failures: list[str] = []
    warnings: list[str] = []
    if interrupted:
        failures.append("operator interruption")
    if not reached_deadline:
        failures.append("measurement deadline was not reached")
    for label, worker in workers.items():
        if worker.error:
            failures.append(f"{label}: {worker.error}")
        for reason in evaluate_stream(
            streams[label],
            requested_seconds=requested_seconds,
            minimum_fps=minimum_fps,
            maximum_fps=maximum_fps,
        ):
            failures.append(f"{label}: {reason}")
        for reason in evaluate_stream_warnings(streams[label]):
            warnings.append(f"{label}: {reason}")
    verdict = "pass" if not failures else "fail"
    now_ns = time.monotonic_ns()
    return {
        "schema": 2,
        "status": "complete" if reached_deadline and not interrupted else "stopped",
        "verdict": verdict,
        "started_at": started_at,
        "summarized_at": utc_now(),
        "provenance": dict(provenance),
        "measurement": {
            "requested_seconds": requested_seconds,
            "startup_exclusion_seconds": startup_exclusion_seconds,
            "elapsed_since_measurement_start_seconds": round(
                max(0, min(now_ns, measurement_end_ns) - measurement_start_ns) / 1_000_000_000,
                3,
            ),
            "reached_deadline": reached_deadline,
        },
        "criteria": {
            "video_rtp_clock_hz": VIDEO_CLOCK,
            "allowed_video_timestamp_deltas": list(EXPECTED_TIMESTAMP_DELTAS),
            "video_timestamp_gap_threshold_ticks": int(VIDEO_CLOCK * 0.040),
            "wall_gap_threshold_ms": (
                next(iter(analyzers.values())).video.wall_gap_threshold_ms
            ),
            "wall_gap_warning_threshold_ms": (
                next(iter(analyzers.values())).video.wall_warning_threshold_ms
            ),
            "wall_gap_failure_threshold_ms": (
                next(iter(analyzers.values())).video.wall_gap_threshold_ms
            ),
            "consecutive_wall_gap_warning_limit": 2,
            "preferred_audio_codec": "opus",
            "opus_rtp_clock_hz": OPUS_CLOCK,
            "opus_timestamp_delta_ticks": OPUS_FRAME_TICKS,
            "opus_frame_duration_ms": 20,
            "opus_wall_gap_threshold_ms": (
                next(iter(analyzers.values())).audio.wall_gap_threshold_ms
            ),
            "opus_wall_gap_warning_threshold_ms": (
                next(iter(analyzers.values())).audio.wall_warning_threshold_ms
            ),
            "opus_wall_gap_failure_threshold_ms": (
                next(iter(analyzers.values())).audio.wall_gap_threshold_ms
            ),
            "av_drift_threshold_ms": DEFAULT_AV_DRIFT_MS,
            "minimum_fps": minimum_fps,
            "maximum_fps": maximum_fps,
            "allowed_anomalies": 0,
        },
        "failure_reasons": failures,
        "warning_reasons": warnings,
        "streams": streams,
    }


def read_url(value: Optional[str], file_value: Optional[str], label: str) -> str:
    if bool(value) == bool(file_value):
        raise ValueError(f"provide exactly one of --{label}-url or --{label}-url-file")
    if file_value:
        path = Path(file_value).expanduser()
        raw = path.read_text().strip()
        if "\n" in raw or "\r" in raw:
            raise ValueError(f"{label} URL file must contain exactly one line")
        value = raw
    assert value is not None
    parse_rtsp_url(value)
    return value


def normalize_mac(value: str) -> str:
    mac = re.sub(r"[:-]", "", value).upper()
    if not re.fullmatch(r"[0-9A-F]{12}", mac):
        raise ValueError("camera MAC must contain exactly 12 hexadecimal digits")
    return mac


def normalize_sha256(value: Optional[str], label: str) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise ValueError(f"{label} must be exactly 64 hexadecimal SHA-256 characters")
    return normalized


def report_provenance(args: argparse.Namespace) -> dict[str, Optional[str]]:
    camera_mac = getattr(args, "camera_mac", None)
    return {
        "requested_camera_mac": normalize_mac(camera_mac) if camera_mac else None,
        "firmware_sha256": normalize_sha256(
            getattr(args, "firmware_sha256", None),
            "firmware hash",
        ),
        "plugin_sha256": normalize_sha256(
            getattr(args, "plugin_sha256", None),
            "plugin hash",
        ),
        "source_sha256": normalize_sha256(
            getattr(args, "source_sha256", None),
            "source hash",
        ),
        "validator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


def discover_urls(log_value: str, camera_mac: str) -> dict[str, str]:
    """Find the newest in-memory video1/video2 URLs without exposing them."""
    log_path = Path(log_value).expanduser()
    mac = normalize_mac(camera_mac)
    found: dict[str, str] = {}
    # Read the rotated generation first; later records in the active file win.
    for path in (Path(str(log_path) + ".1"), log_path):
        if not path.exists():
            continue
        with path.open(errors="replace") as source:
            for line in source:
                match = READY_RE.search(line)
                if not match or normalize_mac(match.group(1)) != mac:
                    continue
                track = match.group(2).lower()
                url = match.group(3)
                parse_rtsp_url(url)
                found[track] = url
    missing = [track for track in ("video1", "video2") if track not in found]
    if missing:
        raise ValueError("ready URL not found for " + ", ".join(missing))
    return {"high": found["video1"], "medium": found["video2"]}


def resolve_urls(args: argparse.Namespace) -> dict[str, str]:
    discovery_requested = bool(args.discover_log)
    explicit_requested = any((
        args.high_url,
        args.high_url_file,
        args.medium_url,
        args.medium_url_file,
    ))
    if discovery_requested:
        if not args.camera_mac:
            raise ValueError("--discover-log and --camera-mac must be supplied together")
        if explicit_requested:
            raise ValueError("log discovery and explicit RTSP URL options are mutually exclusive")
        return discover_urls(args.discover_log, args.camera_mac)
    return {
        "high": read_url(args.high_url, args.high_url_file, "high"),
        "medium": read_url(args.medium_url, args.medium_url_file, "medium"),
    }


def make_test_rtp(
    sequence: int,
    timestamp: int,
    payload: bytes,
    *,
    marker: bool = True,
    payload_type: int = 96,
    ssrc: int = 0x12345678,
) -> bytes:
    """Synthetic fixture helper used by --self-test and the external unit tests."""
    header = bytearray(12)
    header[0] = 0x80
    header[1] = payload_type | (0x80 if marker else 0)
    header[2:4] = (sequence & 0xFFFF).to_bytes(2, "big")
    header[4:8] = (timestamp & 0xFFFFFFFF).to_bytes(4, "big")
    header[8:12] = (ssrc & 0xFFFFFFFF).to_bytes(4, "big")
    return bytes(header) + payload


def make_test_rtcp_sr(ssrc: int, ntp_seconds: float, rtp_timestamp: int) -> bytes:
    """Synthetic RFC 3550 SR fixture helper; no report blocks are included."""
    whole = int(math.floor(ntp_seconds))
    fraction = int((ntp_seconds - whole) * 4_294_967_296.0) & 0xFFFFFFFF
    packet = bytearray(28)
    packet[0] = 0x80
    packet[1] = 200
    packet[2:4] = (6).to_bytes(2, "big")
    packet[4:8] = (ssrc & 0xFFFFFFFF).to_bytes(4, "big")
    packet[8:12] = (whole & 0xFFFFFFFF).to_bytes(4, "big")
    packet[12:16] = fraction.to_bytes(4, "big")
    packet[16:20] = (rtp_timestamp & 0xFFFFFFFF).to_bytes(4, "big")
    return bytes(packet)


def self_test() -> None:
    analyzer = VideoCadenceAnalyzer("self-test", anomaly_limit=2)
    analyzer.configure_window(0, 1_000_000_000)
    base_ts = 0xFFFFF800
    analyzer.consume_rtp(make_test_rtp(0xFFFF, base_ts, b"\x41x"), 0)
    analyzer.consume_rtp(
        make_test_rtp(0, (base_ts + 2_970) & 0xFFFFFFFF, b"\x41y"),
        33_000_000,
    )
    analyzer.consume_rtp(
        make_test_rtp(1, (base_ts + 2_970 + 3_060) & 0xFFFFFFFF, b"\x41z"),
        67_000_000,
    )
    result = analyzer.snapshot()
    assert result["aus"]["clean"] == 2
    assert result["anomalies_total"] == 0

    broken = VideoCadenceAnalyzer("broken", anomaly_limit=2)
    broken.configure_window(0, 1_000_000_000)
    broken.consume_rtp(make_test_rtp(10, 1_000, b"\x41x"), 0)
    broken.consume_rtp(make_test_rtp(12, 7_030, b"\x5c\x45x"), 68_000_000)
    failed = broken.snapshot()
    assert failed["anomaly_counts"]["sequence_gap"] == 1
    assert failed["anomaly_counts"]["timestamp_gap_gt_40ms"] == 1
    assert failed["anomaly_counts"]["wall_gap_gt_threshold"] == 1
    assert failed["anomaly_counts"]["fu_invalid"] >= 1
    assert len(failed["anomalies"]) == 2
    assert failed["anomalies_evicted"] >= 2

    audio = AudioCadenceAnalyzer("audio-self-test", anomaly_limit=2)
    audio.configure_track(AudioTrack(97, "trackID=1", "opus", OPUS_CLOCK, 1, 2, 20.0))
    audio.configure_window(0, 1_000_000_000)
    audio.consume_rtp(make_test_rtp(0xFFFF, 0xFFFFFC80, b"\xf8x", payload_type=97), 0)
    audio.consume_rtp(make_test_rtp(0, 64, b"\xf8y", payload_type=97), 20_000_000)
    assert audio.snapshot()["packets"]["clean"] == 1
    print("self_test=ok")


def resolve_wall_thresholds(args: argparse.Namespace) -> tuple[float, float]:
    """Resolve the warning threshold and hard threshold with legacy CLI support."""
    warning = getattr(args, "wall_warning_ms", None)
    failure = getattr(args, "wall_failure_ms", None)
    legacy_failure = getattr(args, "wall_gap_ms", None)
    if failure is not None and legacy_failure is not None:
        raise ValueError("--wall-failure-ms and --wall-gap-ms are mutually exclusive")
    failure = failure if failure is not None else legacy_failure
    if failure is None:
        failure = DEFAULT_WALL_FAILURE_MS
    if warning is None:
        warning = (
            min(DEFAULT_WALL_WARNING_MS, legacy_failure)
            if legacy_failure is not None
            else DEFAULT_WALL_WARNING_MS
        )
    if warning > failure:
        raise ValueError("wall warning threshold must not exceed the failure threshold")
    return warning, failure


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--high-url", help="high-profile RTSP URL; prefer --high-url-file")
    parser.add_argument("--high-url-file", help="mode-0600 file containing the high-profile URL")
    parser.add_argument("--medium-url", help="medium-profile RTSP URL; prefer --medium-url-file")
    parser.add_argument("--medium-url-file", help="mode-0600 file containing the medium-profile URL")
    parser.add_argument(
        "--discover-log",
        help="discover the latest private video1/video2 URLs from this diagnostic log",
    )
    parser.add_argument(
        "--camera-mac",
        help="requested camera MAC for provenance and safe log discovery (separators optional)",
    )
    parser.add_argument("--firmware-sha256", help="optional flashed firmware SHA-256 provenance")
    parser.add_argument("--plugin-sha256", help="optional deployed plugin SHA-256 provenance")
    parser.add_argument("--source-sha256", help="optional source/patch-set SHA-256 provenance")
    parser.add_argument("--duration", type=float, default=24 * 60 * 60)
    parser.add_argument("--startup-exclusion", type=float, default=DEFAULT_STARTUP_EXCLUSION_SECONDS)
    parser.add_argument(
        "--wall-warning-ms",
        type=float,
        help="isolated receiver wall-gap warning threshold (default: 40 ms)",
    )
    wall_failure = parser.add_mutually_exclusive_group()
    wall_failure.add_argument(
        "--wall-failure-ms",
        type=float,
        help="hard receiver wall-gap failure threshold (default: 67 ms)",
    )
    wall_failure.add_argument(
        "--wall-gap-ms",
        type=float,
        help="deprecated alias for --wall-failure-ms",
    )
    parser.add_argument("--minimum-fps", type=float, default=29.95)
    parser.add_argument("--maximum-fps", type=float, default=30.05)
    parser.add_argument("--anomaly-limit", type=int, default=DEFAULT_ANOMALY_LIMIT)
    parser.add_argument("--connect-timeout", type=float, default=15.0)
    parser.add_argument("--keepalive-interval", type=float, default=20.0)
    parser.add_argument("--report-interval", type=float, default=60.0)
    parser.add_argument("--output", help="JSON report path")
    parser.add_argument("--insecure-tls", action="store_true", help="allow a self-signed rtsps certificate")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return args
    if not args.output:
        parser.error("--output is required")
    numeric = (
        args.duration,
        args.startup_exclusion,
        args.minimum_fps,
        args.maximum_fps,
        args.connect_timeout,
        args.keepalive_interval,
        args.report_interval,
    )
    if any(not math.isfinite(value) or value <= 0 for value in numeric):
        parser.error("durations, thresholds, and frame rates must be positive finite numbers")
    for value in (args.wall_warning_ms, args.wall_failure_ms, args.wall_gap_ms):
        if value is not None and (not math.isfinite(value) or value <= 0):
            parser.error("wall thresholds must be positive finite numbers")
    try:
        resolve_wall_thresholds(args)
    except ValueError as error:
        parser.error(str(error))
    if args.minimum_fps >= args.maximum_fps:
        parser.error("--minimum-fps must be less than --maximum-fps")
    if not 1 <= args.anomaly_limit <= 4096:
        parser.error("--anomaly-limit must be in 1..4096")
    for value, label in (
        (args.firmware_sha256, "--firmware-sha256"),
        (args.plugin_sha256, "--plugin-sha256"),
        (args.source_sha256, "--source-sha256"),
    ):
        try:
            normalize_sha256(value, label)
        except ValueError as error:
            parser.error(str(error))
    return args


def run(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser()
    started_at = utc_now()
    stop_event = threading.Event()
    begin_event = threading.Event()
    ready = {label: threading.Event() for label in ("high", "medium")}
    interrupted = False

    try:
        wall_warning_ms, wall_failure_ms = resolve_wall_thresholds(args)
        urls = resolve_urls(args)
        provenance = report_provenance(args)
    except Exception as error:
        print(f"video-cadence-soak: {safe_error(error)}", file=sys.stderr)
        return 2

    analyzers = {
        label: StreamCadenceAnalyzer(
            label,
            anomaly_limit=args.anomaly_limit,
            wall_gap_threshold_ms=wall_failure_ms,
            wall_warning_threshold_ms=wall_warning_ms,
        )
        for label in urls
    }
    workers = {
        label: StreamWorker(
            label,
            urls[label],
            analyzers[label],
            ready[label],
            begin_event,
            stop_event,
            timeout=args.connect_timeout,
            keepalive_interval=args.keepalive_interval,
            insecure_tls=args.insecure_tls,
        )
        for label in urls
    }

    def request_stop(*_args: object) -> None:
        nonlocal interrupted
        interrupted = True
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    for worker in workers.values():
        worker.start()

    ready_deadline = time.monotonic() + args.connect_timeout * 3
    while not all(event.is_set() for event in ready.values()) and not stop_event.is_set():
        if time.monotonic() >= ready_deadline:
            stop_event.set()
            break
        time.sleep(0.05)

    startup_errors = [f"{label}: {worker.error}" for label, worker in workers.items() if worker.error]
    if not all(worker.opened for worker in workers.values()) and not startup_errors:
        startup_errors.append("not all RTSP streams completed setup")

    measurement_start_ns = time.monotonic_ns() + int(args.startup_exclusion * 1_000_000_000)
    measurement_end_ns = measurement_start_ns + int(args.duration * 1_000_000_000)
    for analyzer in analyzers.values():
        analyzer.configure_window(measurement_start_ns, measurement_end_ns)
    begin_event.set()

    reached_deadline = False
    next_report = time.monotonic()
    if startup_errors:
        stop_event.set()
    try:
        while not stop_event.is_set():
            now_ns = time.monotonic_ns()
            if now_ns >= measurement_end_ns:
                reached_deadline = True
                stop_event.set()
                break
            if any(worker.error for worker in workers.values()):
                stop_event.set()
                break
            if time.monotonic() >= next_report:
                running = build_report(
                    analyzers,
                    workers,
                    started_at=started_at,
                    measurement_start_ns=measurement_start_ns,
                    measurement_end_ns=measurement_end_ns,
                    requested_seconds=args.duration,
                    startup_exclusion_seconds=args.startup_exclusion,
                    minimum_fps=args.minimum_fps,
                    maximum_fps=args.maximum_fps,
                    reached_deadline=False,
                    interrupted=interrupted,
                    provenance=provenance,
                )
                running["status"] = "running"
                running["verdict"] = "pending"
                atomic_json(output, running)
                next_report = time.monotonic() + args.report_interval
            time.sleep(0.1)
    finally:
        stop_event.set()
        begin_event.set()
        for worker in workers.values():
            worker.client.close()
        for worker in workers.values():
            worker.join(timeout=5)

    # Preserve startup failures even if the worker exited before storing one.
    for item in startup_errors:
        label, _, reason = item.partition(": ")
        if label in workers and not workers[label].error:
            workers[label].error = reason
        elif label not in workers:
            workers["high"].error = item
    report = build_report(
        analyzers,
        workers,
        started_at=started_at,
        measurement_start_ns=measurement_start_ns,
        measurement_end_ns=measurement_end_ns,
        requested_seconds=args.duration,
        startup_exclusion_seconds=args.startup_exclusion,
        minimum_fps=args.minimum_fps,
        maximum_fps=args.maximum_fps,
        reached_deadline=reached_deadline,
        interrupted=interrupted,
        provenance=provenance,
    )
    atomic_json(output, report)
    print(json.dumps({
        "status": report["status"],
        "verdict": report["verdict"],
        "output": str(output),
        "failure_count": len(report["failure_reasons"]),
    }))
    return 0 if report["verdict"] == "pass" else 1


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
