#!/usr/bin/env python3
"""Low-impact soak monitor for the deployed UniFi Direct Scrypted plugin.

The monitor runs on the Scrypted host. It discovers the plugin's loopback RTSP
URLs from its diagnostic log, but never writes those URLs (or their random path
tokens) to disk or stdout. Results contain camera labels and aggregate media
health only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TRACKS = {"video1": "high", "video2": "medium"}

READY_RE = re.compile(r"\bDS ([0-9A-F]{12}) (video[12]) ready (rtsp://\S+)")
FRAMECRC_LINE_RE = re.compile(r"^\s*\d+\s*,")
RTSP_RE = re.compile(r"(?:rtsp|rtsps)://\S+", re.IGNORECASE)
TOKEN_RE = re.compile(r"(?i)(?:token|password|passwd|secret|credential)=\S+")
AUDIO_STREAM_RE = re.compile(
    r"\bAudio:\s*([A-Za-z0-9_.-]+)(?:\s*\(([^)]*)\))?",
    re.IGNORECASE,
)
AUDIO_BITRATE_RE = re.compile(r"\b(\d+(?:\.\d+)?)\s*kb/s\b", re.IGNORECASE)

AAC_OBJECT_TYPES = {
    "main": 1,
    "lc": 2,
    "ssr": 3,
    "ltp": 4,
    "he-aac": 5,
    "he-aacv2": 29,
    "ld": 23,
    "eld": 39,
}

ERROR_PATTERNS = {
    "pipeline_restart": re.compile(r"pipeline restart|restarting media pipeline", re.I),
    "pipeline_closed": re.compile(r"native media pipeline closed", re.I),
    "audio_error": re.compile(r"audio (?:parse|packet|rtp|decode)?\s*error|unparsable AudioSpecificConfig", re.I),
    "video_error": re.compile(r"video tag error", re.I),
    "sequence_header_change": re.compile(r"sequence header changed", re.I),
    "queue_overflow": re.compile(r"(?:queue|gop buffer) overflow", re.I),
    "timestamp_discontinuity": re.compile(r"timestamp discontinuity", re.I),
    "backpressure": re.compile(r"backpressure", re.I),
    "unrouted_push": re.compile(r"unrouted.*push|no route", re.I),
    "camera_disconnect": re.compile(
        r"camera disconnect|management.*disconnect|camera stream error|stream connection dropped",
        re.I,
    ),
    "stream_probe_timeout": re.compile(r"stream probe timed out", re.I),
    "start_stream_failed": re.compile(r"startStream failed", re.I),
}

DEFAULT_FFMPEG = (
    "/Applications/Scrypted.app/Contents/Resources/app/node_modules/"
    "@scrypted/ffmpeg-static/artifacts/ffmpeg-darwin-arm64"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def safe_text(value: str, limit: int = 240) -> str:
    value = RTSP_RE.sub("[redacted-rtsp]", value)
    value = TOKEN_RE.sub("[redacted-secret]", value)
    return " ".join(value.split())[:limit]


def camera_argument(value: str) -> tuple[str, str]:
    try:
        raw_mac, label = value.split("=", 1)
    except ValueError as error:
        raise argparse.ArgumentTypeError("camera must be MAC=LABEL") from error
    mac = re.sub(r"[:-]", "", raw_mac).upper()
    label = " ".join(label.split())
    if not re.fullmatch(r"[0-9A-F]{12}", mac):
        raise argparse.ArgumentTypeError("camera MAC must contain 12 hexadecimal digits")
    if not label or len(label) > 80:
        raise argparse.ArgumentTypeError("camera label must contain 1-80 characters")
    return mac, label


def error_category(stderr: str, returncode: int | None = None) -> str:
    text = stderr.lower()
    for pattern, category in (
        ("timed out", "timeout"),
        ("connection refused", "connection-refused"),
        ("404 not found", "not-found"),
        ("invalid data", "invalid-data"),
        ("error while decoding", "decode-error"),
        ("non monotonically increasing", "non-monotonic"),
        ("no such file", "missing-binary"),
    ):
        if pattern in text:
            return category
    return f"exit-{returncode}" if returncode is not None else "unknown"


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * q
    low, high = math.floor(at), math.ceil(at)
    return ordered[low] + (ordered[high] - ordered[low]) * (at - low)


def atomic_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def run_command(args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_framecrc_command(
    args: list[str],
    timeout: float,
) -> tuple[subprocess.CompletedProcess[str], list[float]]:
    """Run framecrc while timestamping each flushed output frame."""
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        bufsize=1,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    frame_arrivals: list[float] = []

    def read_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            stdout_lines.append(line)
            if FRAMECRC_LINE_RE.match(line):
                frame_arrivals.append(time.monotonic())

    def read_stderr() -> None:
        assert process.stderr is not None
        stderr_lines.extend(process.stderr)

    readers = [
        threading.Thread(target=read_stdout, name="framecrc-stdout", daemon=True),
        threading.Thread(target=read_stderr, name="framecrc-stderr", daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        for reader in readers:
            reader.join(timeout=1)
        raise subprocess.TimeoutExpired(args, timeout)
    for reader in readers:
        reader.join(timeout=1)
    return (
        subprocess.CompletedProcess(
            args,
            returncode,
            stdout="".join(stdout_lines),
            stderr="".join(stderr_lines),
        ),
        frame_arrivals,
    )


def parse_framecrc(output: str) -> list[dict[str, int | str]]:
    frames: list[dict[str, int | str]] = []
    for line in output.splitlines():
        if not FRAMECRC_LINE_RE.match(line):
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 6:
            continue
        try:
            frames.append(
                {
                    "stream": int(parts[0]),
                    "dts": int(parts[1]),
                    "pts": int(parts[2]),
                    "duration": int(parts[3]),
                    "size": int(parts[4]),
                    "crc": parts[5],
                }
            )
        except ValueError:
            continue
    return frames


def parse_framecrc_metadata(output: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for line in output.splitlines():
        match = re.match(r"^#([a-z_]+)\s+\d+:\s*(.+?)\s*$", line)
        if not match:
            continue
        key, value = match.groups()
        if key == "tb":
            time_base = re.fullmatch(r"(\d+)/(\d+)", value)
            if time_base and int(time_base.group(2)):
                metadata["time_base"] = [int(time_base.group(1)), int(time_base.group(2))]
        elif key == "sample_rate":
            try:
                metadata["sample_rate"] = int(value)
            except ValueError:
                pass
        elif key == "channel_layout_name":
            metadata["channel_layout"] = value
        elif key == "codec_id":
            metadata["codec"] = value
    return metadata


def parse_ffmpeg_audio_metadata(output: str) -> dict[str, Any]:
    """Extract source codec details from FFmpeg's human-readable stream lines."""
    for line in output.splitlines():
        match = AUDIO_STREAM_RE.search(line)
        if not match:
            continue
        codec, profile = match.groups()
        metadata: dict[str, Any] = {"codec": codec.lower()}
        if profile:
            metadata["codec_profile"] = profile.strip()
        bitrate = AUDIO_BITRATE_RE.search(line[match.end():])
        if bitrate:
            metadata["declared_bitrate_bps"] = round(float(bitrate.group(1)) * 1000)
        break
    else:
        return {}
    profile = metadata.get("codec_profile")
    if metadata.get("codec") == "aac" and isinstance(profile, str):
        object_type = AAC_OBJECT_TYPES.get(profile.casefold().replace(" ", ""))
        if object_type is not None:
            metadata["aac_object_type"] = object_type
    return metadata


def numeric_summary(values: list[int | float]) -> dict[str, int | float | None]:
    return {
        "samples": len(values),
        "min": min(values) if values else None,
        "median": statistics.median(values) if values else None,
        "max": max(values) if values else None,
    }


def timestamp_anomalies(frames: list[dict[str, int | str]]) -> dict[str, int]:
    duplicate_or_backwards = 0
    positive_gaps = 0
    cadence_anomalies = 0
    repeated_crc = 0
    for previous, current in zip(frames, frames[1:]):
        delta = int(current["pts"]) - int(previous["pts"])
        duration = int(previous["duration"])
        if delta <= 0:
            duplicate_or_backwards += 1
        if duration > 0 and delta > duration:
            positive_gaps += 1
        if duration > 0 and delta != duration:
            cadence_anomalies += 1
        if current["crc"] == previous["crc"]:
            repeated_crc += 1
    return {
        "nonpositive_pts": duplicate_or_backwards,
        "positive_pts_gaps": positive_gaps,
        "cadence_anomalies": cadence_anomalies,
        "adjacent_repeated_crc": repeated_crc,
    }


def arrival_anomalies(
    frames: list[dict[str, int | str]],
    arrivals: list[float],
    time_base: list[int] | None,
    stall_threshold_ms: float,
) -> dict[str, Any]:
    result = {
        "arrival_observable": False,
        "arrival_stalls": 0,
        "arrival_gap_max_ms": None,
        "arrival_excess_max_ms": None,
    }
    if not time_base or len(frames) <= 1 or len(arrivals) != len(frames):
        return result
    numerator, denominator = time_base
    durations = [int(frame["duration"]) for frame in frames[:-1]]
    if denominator <= 0 or any(duration <= 0 for duration in durations):
        return result
    arrival_gaps = [
        (current - previous) * 1000
        for previous, current in zip(arrivals, arrivals[1:])
    ]
    expected_gaps = [duration * numerator / denominator * 1000 for duration in durations]
    excesses = [actual - expected for actual, expected in zip(arrival_gaps, expected_gaps)]
    result.update(
        {
            "arrival_observable": True,
            "arrival_stalls": sum(excess > stall_threshold_ms for excess in excesses),
            "arrival_gap_max_ms": round(max(arrival_gaps), 1),
            "arrival_excess_max_ms": round(max(0.0, max(excesses)), 1),
        }
    )
    return result


class SoakMonitor:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.cameras: dict[str, str] = args.cameras
        self.log_path = Path(args.log)
        self.run_dir = Path(args.run_dir).expanduser()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.events_path = self.run_dir / "events.jsonl"
        self.state_path = self.run_dir / "state.json"
        self.summary_path = self.run_dir / "summary.json"
        self.pid_path = self.run_dir / "monitor.pid"
        self.stop_requested = False
        self.pid_acquired = False
        self.state = self.load_state()
        self.sources: dict[tuple[str, str], str] = {}

    def load_state(self) -> dict[str, Any]:
        if self.state_path.exists():
            state = json.loads(self.state_path.read_text())
            if state.get("schema") != 1:
                raise RuntimeError("unsupported soak state schema")
            return state
        now = time.time()
        return {
            "schema": 1,
            "started_epoch": now,
            "deadline_epoch": now + self.args.duration,
            "last_health_epoch": 0,
            "last_startup_epoch": 0,
            "last_deep_epoch": 0,
            "log_offset": self.log_path.stat().st_size if self.log_path.exists() else 0,
            "log_inode": self.log_path.stat().st_ino if self.log_path.exists() else None,
            "last_plugin_pid": None,
        }

    def save_state(self) -> None:
        atomic_json(self.state_path, self.state)

    def append_event(self, kind: str, **data: Any) -> None:
        event = {"schema": 1, "at": utc_now(), "epoch": time.time(), "kind": kind, **data}
        with self.events_path.open("a") as output:
            output.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")

    def acquire_pid(self) -> None:
        while True:
            try:
                fd = os.open(self.pid_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                try:
                    old_pid = int(self.pid_path.read_text().strip())
                except ValueError:
                    old_pid = None
                except OSError as error:
                    raise RuntimeError("cannot inspect existing soak monitor lock") from error
                if old_pid is not None:
                    try:
                        os.kill(old_pid, 0)
                    except ProcessLookupError:
                        pass
                    except PermissionError as error:
                        raise RuntimeError(f"cannot verify existing soak monitor pid {old_pid}") from error
                    else:
                        raise RuntimeError(f"soak monitor already running as pid {old_pid}")
                try:
                    self.pid_path.unlink()
                except FileNotFoundError:
                    pass
                continue
            try:
                os.write(fd, f"{os.getpid()}\n".encode())
            finally:
                os.close(fd)
            self.pid_acquired = True
            return

    def discover_sources(self) -> dict[tuple[str, str], str]:
        found: dict[tuple[str, str], str] = {}
        rotated_path = Path(str(self.log_path) + ".1")
        # Read the rotated generation first so a newer URL in the active log wins.
        for log_path in (rotated_path, self.log_path):
            if not log_path.exists():
                continue
            with log_path.open(errors="ignore") as source:
                for line in source:
                    match = READY_RE.search(line)
                    if not match:
                        continue
                    key = (match.group(1), match.group(2))
                    if key[0] in self.cameras and key[1] in TRACKS:
                        found[key] = match.group(3)
        # Keep the last usable URL in memory across rotations. URLs are deliberately
        # excluded from state.json, events.jsonl, and summary.json.
        self.sources.update(found)
        return dict(self.sources)

    @staticmethod
    def count_log_markers(path: Path, offset: int, counts: dict[str, int]) -> int:
        with path.open(errors="ignore") as source:
            source.seek(offset)
            for line in source:
                for key, pattern in ERROR_PATTERNS.items():
                    if pattern.search(line):
                        counts[key] += 1
            return source.tell()

    def scan_log(self) -> dict[str, int]:
        counts = {key: 0 for key in ERROR_PATTERNS}
        if not self.log_path.exists():
            return counts
        stat = self.log_path.stat()
        previous_inode = self.state.get("log_inode")
        previous_offset = int(self.state.get("log_offset", 0))
        if previous_inode is not None and previous_inode != stat.st_ino:
            rotated_path = Path(str(self.log_path) + ".1")
            if rotated_path.exists() and rotated_path.stat().st_ino == previous_inode:
                self.count_log_markers(rotated_path, previous_offset, counts)
            previous_offset = 0
        elif previous_offset > stat.st_size:
            previous_offset = 0
        self.state["log_offset"] = self.count_log_markers(self.log_path, previous_offset, counts)
        self.state["log_inode"] = stat.st_ino
        return counts

    def plugin_process(self) -> dict[str, Any]:
        try:
            run = run_command(["ps", "ax", "-o", "pid=,rss=,etime=,command="], timeout=5)
        except (OSError, subprocess.TimeoutExpired) as error:
            return {"pid": None, "matches": 0, "error": error_category(str(error))}
        matches = []
        suffix = f" child {self.args.plugin_id}"
        for line in run.stdout.splitlines():
            if suffix not in line:
                continue
            match = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$", line)
            if match:
                matches.append(
                    {
                        "pid": int(match.group(1)),
                        "rss_kib": int(match.group(2)),
                        "elapsed": match.group(3),
                    }
                )
        return matches[0] if len(matches) == 1 else {"pid": None, "matches": len(matches)}

    def push_connections(self, pid: int | None) -> dict[str, Any]:
        result: dict[str, Any] = {
            "high": 0,
            "medium": 0,
            "total": 0,
            "high_unique_peers": 0,
            "medium_unique_peers": 0,
        }
        if not pid:
            return result
        try:
            run = run_command(["lsof", "-nP", "-a", "-p", str(pid), "-iTCP"], timeout=8)
        except (OSError, subprocess.TimeoutExpired) as error:
            result["error"] = error_category(str(error))
            return result
        peers = {"high": set(), "medium": set()}
        for line in run.stdout.splitlines():
            if "(ESTABLISHED)" not in line:
                continue
            endpoint = re.search(r"TCP\s+\S+:(\d+)->(\S+):\d+\s+\(ESTABLISHED\)", line)
            if not endpoint:
                continue
            local_port, peer = endpoint.groups()
            if local_port == "17550":
                result["high"] += 1
                peers["high"].add(peer)
            elif local_port == "17551":
                result["medium"] += 1
                peers["medium"].add(peer)
        result["total"] = result["high"] + result["medium"]
        result["high_unique_peers"] = len(peers["high"])
        result["medium_unique_peers"] = len(peers["medium"])
        return result

    def health_probe(self) -> None:
        process = self.plugin_process()
        pid = process.get("pid")
        previous_pid = self.state.get("last_plugin_pid")
        pid_changed = previous_pid is not None and pid is not None and pid != previous_pid
        if pid:
            self.state["last_plugin_pid"] = pid
        connections = self.push_connections(pid)
        markers = self.scan_log()
        self.append_event(
            "health",
            process=process,
            pid_changed=pid_changed,
            connections=connections,
            connection_expectation={
                "high": len(self.cameras),
                "medium": len(self.cameras),
                "total": len(self.cameras) * len(TRACKS),
                "unique_peers_per_profile": len(self.cameras),
            },
            media_error_markers=markers,
        )

    def startup_probe_one(self, key: tuple[str, str], url: str) -> dict[str, Any]:
        mac, track = key
        started = time.monotonic()
        command = [
            self.args.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-xerror",
            "-rtsp_transport",
            "tcp",
            "-analyzeduration",
            "0",
            "-probesize",
            "65536",
            "-i",
            url,
            "-map",
            "0:v:0",
            "-an",
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ]
        try:
            run = run_command(command, timeout=self.args.probe_timeout)
            elapsed_ms = (time.monotonic() - started) * 1000
            result = {
                "camera": self.cameras[mac],
                "profile": TRACKS[track],
                "ok": run.returncode == 0,
                "first_decoded_ms": round(elapsed_ms, 1),
            }
            if run.returncode:
                result["error"] = error_category(run.stderr, run.returncode)
            return result
        except subprocess.TimeoutExpired:
            return {
                "camera": self.cameras[mac],
                "profile": TRACKS[track],
                "ok": False,
                "error": "timeout",
            }
        except OSError as error:
            return {
                "camera": self.cameras[mac],
                "profile": TRACKS[track],
                "ok": False,
                "error": error_category(str(error)),
            }

    def startup_probe(self) -> None:
        sources = self.discover_sources()
        expected = len(self.cameras) * len(TRACKS)
        results = [self.startup_probe_one(key, url) for key, url in sorted(sources.items())]
        missing_keys = [
            (mac, track)
            for mac in self.cameras
            for track in TRACKS
            if (mac, track) not in sources
        ]
        results.extend(
            {
                "camera": self.cameras[mac],
                "profile": TRACKS[track],
                "ok": False,
                "error": "source-missing",
            }
            for mac, track in missing_keys
        )
        self.append_event(
            "startup",
            discovered=len(sources),
            expected=expected,
            missing=len(missing_keys),
            streams=results,
        )

    def framecrc_probe(self, url: str, media: str) -> dict[str, Any]:
        mapping = "0:v:0" if media == "video" else "0:a:0"
        disable = ["-an"] if media == "video" else ["-vn"]
        command = [
            self.args.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error" if media == "video" else "info",
            "-xerror",
            "-rtsp_transport",
            "tcp",
            "-i",
            url,
            "-map",
            mapping,
            *disable,
            "-t",
            str(self.args.deep_seconds),
            "-flush_packets",
            "1",
            "-f",
            "framecrc",
            "pipe:1",
        ]
        started = time.monotonic()
        try:
            run, frame_arrivals = run_framecrc_command(
                command,
                timeout=max(self.args.probe_timeout, self.args.deep_seconds + 10),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "timeout", "frames": 0, "wall_ms": None}
        except OSError as error:
            return {
                "ok": False,
                "error": error_category(str(error)),
                "frames": 0,
                "wall_ms": round((time.monotonic() - started) * 1000, 1),
            }
        wall_ms = round((time.monotonic() - started) * 1000, 1)
        frames = parse_framecrc(run.stdout)
        metadata = parse_framecrc_metadata(run.stdout)
        audio_metadata = parse_ffmpeg_audio_metadata(run.stderr) if media == "audio" else {}
        anomalies = timestamp_anomalies(frames)
        coverage_seconds = None
        time_base = metadata.get("time_base")
        if frames and time_base:
            numerator, denominator = time_base
            first_pts = min(int(frame["pts"]) for frame in frames)
            last_end = max(int(frame["pts"]) + max(0, int(frame["duration"])) for frame in frames)
            coverage_seconds = (last_end - first_pts) * numerator / denominator
        arrival = arrival_anomalies(
            frames,
            frame_arrivals,
            time_base,
            self.args.stall_threshold_ms,
        )
        coverage_ok = coverage_seconds is None or coverage_seconds >= self.args.deep_seconds * 0.8
        result: dict[str, Any] = {
            "ok": (
                run.returncode == 0
                and bool(frames)
                and coverage_ok
                and anomalies["nonpositive_pts"] == 0
                and anomalies["cadence_anomalies"] == 0
                and arrival["arrival_observable"]
                and arrival["arrival_stalls"] == 0
            ),
            "frames": len(frames),
            "wall_ms": wall_ms,
            "coverage_seconds": round(coverage_seconds, 4) if coverage_seconds is not None else None,
            **arrival,
            **anomalies,
        }
        if media == "audio":
            result["sample_rate"] = metadata.get("sample_rate")
            result["channel_layout"] = metadata.get("channel_layout")
            result["codec"] = audio_metadata.get("codec") or metadata.get("codec")
            result["codec_profile"] = audio_metadata.get("codec_profile")
            result["aac_object_type"] = audio_metadata.get("aac_object_type")
            result["declared_bitrate_bps"] = audio_metadata.get("declared_bitrate_bps")
            result.update(self.audio_bitrate_probe(url))
        if run.returncode:
            result["error"] = error_category(run.stderr, run.returncode)
        elif not coverage_ok:
            result["error"] = "insufficient-media-coverage"
        elif anomalies["cadence_anomalies"]:
            result["error"] = "timestamp-cadence"
        elif not arrival["arrival_observable"]:
            result["error"] = "arrival-unobservable"
        elif arrival["arrival_stalls"]:
            result["error"] = "arrival-stall"
        return result

    def audio_bitrate_probe(self, url: str) -> dict[str, Any]:
        """Best-effort encoded-packet sample; decoder health remains authoritative."""
        command = [
            self.args.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-xerror",
            "-rtsp_transport",
            "tcp",
            "-i",
            url,
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "copy",
            "-t",
            str(self.args.deep_seconds),
            "-f",
            "framecrc",
            "pipe:1",
        ]
        try:
            run = run_command(
                command,
                timeout=max(self.args.probe_timeout, self.args.deep_seconds + 10),
            )
        except subprocess.TimeoutExpired:
            return {"bitrate_probe_error": "timeout"}
        except OSError as error:
            return {"bitrate_probe_error": error_category(str(error))}
        if run.returncode:
            return {"bitrate_probe_error": error_category(run.stderr, run.returncode)}
        frames = parse_framecrc(run.stdout)
        metadata = parse_framecrc_metadata(run.stdout)
        time_base = metadata.get("time_base")
        if not frames or not time_base:
            return {"bitrate_probe_error": "metadata-unavailable"}
        numerator, denominator = time_base
        if numerator <= 0 or denominator <= 0:
            return {"bitrate_probe_error": "metadata-unavailable"}
        first_pts = min(int(frame["pts"]) for frame in frames)
        last_end = max(
            int(frame["pts"]) + max(0, int(frame["duration"]))
            for frame in frames
        )
        coverage_seconds = (last_end - first_pts) * numerator / denominator
        if coverage_seconds <= 0:
            return {"bitrate_probe_error": "metadata-unavailable"}
        return {
            "bitrate_bps": round(
                sum(int(frame["size"]) for frame in frames) * 8 / coverage_seconds
            ),
            "bitrate_source": "encoded-frame-sizes",
            "bitrate_probe_frames": len(frames),
            "bitrate_probe_seconds": round(coverage_seconds, 4),
        }

    def deep_probe(self) -> None:
        sources = self.discover_sources()
        video_results = []
        for (mac, track), url in sorted(sources.items()):
            video_results.append(
                {
                    "camera": self.cameras[mac],
                    "profile": TRACKS[track],
                    **self.framecrc_probe(url, "video"),
                }
            )
        missing_keys = [
            (mac, track)
            for mac in self.cameras
            for track in TRACKS
            if (mac, track) not in sources
        ]
        video_results.extend(
            {
                "camera": self.cameras[mac],
                "profile": TRACKS[track],
                "ok": False,
                "error": "source-missing",
                "frames": 0,
            }
            for mac, track in missing_keys
        )
        audio_results = []
        for mac, camera in self.cameras.items():
            url = f"rtsp://127.0.0.1:17553/{mac}"
            audio_results.append({"camera": camera, **self.framecrc_probe(url, "audio")})
        self.append_event(
            "deep",
            video_discovered=len(sources),
            video_expected=len(self.cameras) * len(TRACKS),
            video_missing=len(missing_keys),
            video=video_results,
            audio=audio_results,
        )

    def load_events(self) -> list[dict[str, Any]]:
        if not self.events_path.exists():
            return []
        events = []
        with self.events_path.open() as source:
            for line in source:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return events

    def build_summary(self, final: bool) -> dict[str, Any]:
        events = self.load_events()
        health = [event for event in events if event.get("kind") == "health"]
        startup = [event for event in events if event.get("kind") == "startup"]
        deep = [event for event in events if event.get("kind") == "deep"]
        fatal = [event for event in events if event.get("kind") == "monitor_fatal"]
        rss = [event["process"].get("rss_kib") for event in health if event.get("process", {}).get("rss_kib")]
        connections = [event.get("connections", {}) for event in health]
        marker_totals = {key: 0 for key in ERROR_PATTERNS}
        for event in health:
            for key, value in event.get("media_error_markers", {}).items():
                marker_totals[key] = marker_totals.get(key, 0) + int(value)
        stream_outcomes: dict[str, dict[str, Any]] = {}
        startup_failures = 0
        for event in startup:
            for stream in event.get("streams", []):
                label = f'{stream.get("camera")}/{stream.get("profile")}'
                outcome = stream_outcomes.setdefault(label, {"attempts": 0, "failures": 0, "timings": []})
                outcome["attempts"] += 1
                if stream.get("ok") and stream.get("first_decoded_ms") is not None:
                    outcome["timings"].append(float(stream["first_decoded_ms"]))
                else:
                    outcome["failures"] += 1
                    startup_failures += 1
        timing_summary = {}
        for label, outcome in sorted(stream_outcomes.items()):
            values = outcome.pop("timings")
            timing_summary[label] = {
                **outcome,
                "successes": len(values),
                "median_ms": round(percentile(values, 0.5), 1) if values else None,
                "p95_ms": round(percentile(values, 0.95), 1) if values else None,
                "max_ms": round(max(values), 1) if values else None,
            }
        video_rows = [row for event in deep for row in event.get("video", [])]
        audio_rows = [row for event in deep for row in event.get("audio", [])]
        audio_profiles: dict[str, int] = {}
        audio_codec_profiles: dict[str, int] = {}
        aac_object_types: dict[str, int] = {}
        audio_bitrates: list[int | float] = []
        declared_audio_bitrates: list[int | float] = []
        for row in audio_rows:
            sample_rate = row.get("sample_rate")
            channel_layout = row.get("channel_layout")
            if sample_rate or channel_layout:
                label = f"{sample_rate or 'unknown'}Hz/{channel_layout or 'unknown'}"
                audio_profiles[label] = audio_profiles.get(label, 0) + 1
            codec = row.get("codec")
            codec_profile = row.get("codec_profile")
            if codec or codec_profile:
                label = f"{codec or 'unknown'}/{codec_profile or 'unknown'}"
                audio_codec_profiles[label] = audio_codec_profiles.get(label, 0) + 1
            object_type = row.get("aac_object_type")
            if object_type is not None:
                label = str(object_type)
                aac_object_types[label] = aac_object_types.get(label, 0) + 1
            bitrate = row.get("bitrate_bps")
            if isinstance(bitrate, (int, float)) and not isinstance(bitrate, bool):
                audio_bitrates.append(bitrate)
            declared_bitrate = row.get("declared_bitrate_bps")
            if isinstance(declared_bitrate, (int, float)) and not isinstance(declared_bitrate, bool):
                declared_audio_bitrates.append(declared_bitrate)
        ended_epoch = time.time()
        if not final:
            status = "running"
        elif fatal:
            status = "failed"
        elif ended_epoch >= self.state["deadline_epoch"]:
            status = "complete"
        else:
            status = "stopped"
        summary = {
            "schema": 1,
            "status": status,
            "started_at": datetime.fromtimestamp(self.state["started_epoch"], timezone.utc).isoformat(),
            "deadline_at": datetime.fromtimestamp(self.state["deadline_epoch"], timezone.utc).isoformat(),
            "summarized_at": utc_now(),
            "elapsed_seconds": round(ended_epoch - self.state["started_epoch"], 1),
            "samples": {"health": len(health), "startup": len(startup), "deep": len(deep)},
            "plugin_pid_changes": sum(bool(event.get("pid_changed")) for event in health),
            "plugin_unavailable_samples": sum(event.get("process", {}).get("pid") is None for event in health),
            "fatal_events": len(fatal),
            "fatal_reasons": sorted({str(event.get("error", "unknown")) for event in fatal}),
            "rss_kib": {
                "min": min(rss) if rss else None,
                "median": statistics.median(rss) if rss else None,
                "max": max(rss) if rss else None,
            },
            "connection_minima": {
                "high": min((row.get("high", 0) for row in connections), default=None),
                "medium": min((row.get("medium", 0) for row in connections), default=None),
                "total": min((row.get("total", 0) for row in connections), default=None),
                "high_unique_peers": min(
                    (row.get("high_unique_peers", 0) for row in connections),
                    default=None,
                ),
                "medium_unique_peers": min(
                    (row.get("medium_unique_peers", 0) for row in connections),
                    default=None,
                ),
            },
            "media_error_markers": marker_totals,
            "startup": {"failures": startup_failures, "streams": timing_summary},
            "deep_video": {
                "probes": len(video_rows),
                "failures": sum(not row.get("ok") for row in video_rows),
                "nonpositive_pts": sum(int(row.get("nonpositive_pts", 0)) for row in video_rows),
                "positive_pts_gaps": sum(int(row.get("positive_pts_gaps", 0)) for row in video_rows),
                "cadence_anomalies": sum(int(row.get("cadence_anomalies", 0)) for row in video_rows),
                "arrival_stalls": sum(int(row.get("arrival_stalls", 0)) for row in video_rows),
                "arrival_unobservable": sum(not row.get("arrival_observable", False) for row in video_rows),
                "arrival_excess_max_ms": max(
                    (float(row["arrival_excess_max_ms"]) for row in video_rows if row.get("arrival_excess_max_ms") is not None),
                    default=None,
                ),
            },
            "deep_audio": {
                "probes": len(audio_rows),
                "failures": sum(not row.get("ok") for row in audio_rows),
                "cadence_anomalies": sum(int(row.get("cadence_anomalies", 0)) for row in audio_rows),
                "nonpositive_pts": sum(int(row.get("nonpositive_pts", 0)) for row in audio_rows),
                "positive_pts_gaps": sum(int(row.get("positive_pts_gaps", 0)) for row in audio_rows),
                "arrival_stalls": sum(int(row.get("arrival_stalls", 0)) for row in audio_rows),
                "arrival_unobservable": sum(not row.get("arrival_observable", False) for row in audio_rows),
                "arrival_excess_max_ms": max(
                    (float(row["arrival_excess_max_ms"]) for row in audio_rows if row.get("arrival_excess_max_ms") is not None),
                    default=None,
                ),
                "profiles": dict(sorted(audio_profiles.items())),
                "codec_profiles": dict(sorted(audio_codec_profiles.items())),
                "aac_object_types": dict(sorted(aac_object_types.items())),
                "bitrate_bps": numeric_summary(audio_bitrates),
                "declared_bitrate_bps": numeric_summary(declared_audio_bitrates),
                "bitrate_probe_failures": sum(
                    bool(row.get("bitrate_probe_error")) for row in audio_rows
                ),
            },
        }
        return summary

    def write_summary(self, final: bool) -> None:
        atomic_json(self.summary_path, self.build_summary(final))

    def run(self) -> int:
        self.acquire_pid()
        resumed = self.events_path.exists() and self.events_path.stat().st_size > 0
        self.save_state()
        self.append_event(
            "monitor_start",
            resumed=resumed,
            duration_seconds=self.state["deadline_epoch"] - self.state["started_epoch"],
            intervals={
                "health": self.args.health_interval,
                "startup": self.args.startup_interval,
                "deep": self.args.deep_interval,
            },
            deep_seconds=self.args.deep_seconds,
            stall_threshold_ms=self.args.stall_threshold_ms,
        )
        try:
            while not self.stop_requested and time.time() < self.state["deadline_epoch"]:
                now = time.time()
                if now - self.state["last_health_epoch"] >= self.args.health_interval:
                    self.health_probe()
                    self.state["last_health_epoch"] = time.time()
                if now - self.state["last_startup_epoch"] >= self.args.startup_interval:
                    self.startup_probe()
                    self.state["last_startup_epoch"] = time.time()
                if now - self.state["last_deep_epoch"] >= self.args.deep_interval:
                    self.deep_probe()
                    self.state["last_deep_epoch"] = time.time()
                self.save_state()
                self.write_summary(final=False)
                next_due = min(
                    self.state["last_health_epoch"] + self.args.health_interval,
                    self.state["last_startup_epoch"] + self.args.startup_interval,
                    self.state["last_deep_epoch"] + self.args.deep_interval,
                    self.state["deadline_epoch"],
                )
                time.sleep(max(0.2, min(5.0, next_due - time.time())))
            self.append_event("monitor_stop", requested=self.stop_requested)
            self.write_summary(final=True)
            return 0
        finally:
            try:
                self.pid_path.unlink()
            except FileNotFoundError:
                pass


def self_test() -> None:
    assert safe_text("failed rtsp://user:pass@host/path?token=abc") == "failed [redacted-rtsp]"
    assert camera_argument("aa:bb:cc:dd:ee:ff=Camera One") == ("AABBCCDDEEFF", "Camera One")
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    test_cameras = {
        "020000000001": "Camera 1",
        "020000000002": "Camera 2",
        "020000000003": "Camera 3",
        "020000000004": "Camera 4",
    }
    audio_fixture = (
        "#tb 0: 1/32000\n"
        "#codec_id 0: pcm_s16le\n"
        "#sample_rate 0: 32000\n"
        "#channel_layout_name 0: mono\n"
        "0, 0, 0, 1024, 2048, 0xaaaa\n"
        "0, 1024, 1024, 1024, 2048, 0xbbbb\n"
    )
    audio_packet_fixture = (
        "#tb 0: 1/32000\n"
        "#codec_id 0: aac\n"
        "#sample_rate 0: 32000\n"
        "#channel_layout_name 0: mono\n"
        "0, 0, 0, 1024, 512, 0xaaaa\n"
        "0, 1024, 1024, 1024, 512, 0xbbbb\n"
    )
    audio_stderr_fixture = (
        "Stream #0:0: Audio: aac (LC), 32000 Hz, mono, fltp, 128 kb/s\n"
    )
    video_fixture = (
        "#tb 0: 1/25\n"
        "0, 0, 0, 1, 128, 0xaaaa\n"
        "0, 1, 1, 1, 128, 0xbbbb\n"
        "0, 2, 2, 1, 128, 0xcccc\n"
    )
    frames = parse_framecrc(audio_fixture)
    assert len(frames) == 2
    assert parse_framecrc_metadata(audio_fixture) == {
        "time_base": [1, 32000],
        "sample_rate": 32000,
        "channel_layout": "mono",
        "codec": "pcm_s16le",
    }
    assert parse_ffmpeg_audio_metadata(audio_stderr_fixture) == {
        "codec": "aac",
        "codec_profile": "LC",
        "declared_bitrate_bps": 128000,
        "aac_object_type": 2,
    }
    assert parse_ffmpeg_audio_metadata("Stream #0:0: Audio: aac, 16000 Hz, mono\n") == {
        "codec": "aac",
    }
    assert parse_ffmpeg_audio_metadata(
        "Stream #0:0: Audio: aac (LC), 32000 Hz, mono, fltp\n"
        "Stream #0:0: Audio: pcm_s16le, 32000 Hz, mono, s16, 512 kb/s\n"
    ) == {
        "codec": "aac",
        "codec_profile": "LC",
        "aac_object_type": 2,
    }
    assert numeric_summary([]) == {"samples": 0, "min": None, "median": None, "max": None}
    assert timestamp_anomalies(frames) == {
        "nonpositive_pts": 0,
        "positive_pts_gaps": 0,
        "cadence_anomalies": 0,
        "adjacent_repeated_crc": 0,
    }
    gap_frames = parse_framecrc(
        "0, 0, 0, 1, 128, 0xaaaa\n"
        "0, 2, 2, 1, 128, 0xbbbb\n"
    )
    assert timestamp_anomalies(gap_frames)["positive_pts_gaps"] == 1
    assert arrival_anomalies(frames, [0.0, 0.03], [1, 32000], 150)["arrival_stalls"] == 0
    assert arrival_anomalies(frames, [0.0, 0.25], [1, 32000], 150)["arrival_stalls"] == 1

    original_run_command = run_command
    original_framecrc_command = run_framecrc_command

    def fake_run_command(args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        del timeout
        if args[0] == "ps":
            stdout = " 4242 123456 01:02:03 node plugin-host child @scrypted/unifi-direct\n"
        elif args[0] == "lsof":
            stdout = "\n".join(
                [
                    f"node 4242 user 1u IPv4 TCP 127.0.0.1:17550->192.0.2.{index}:20000 (ESTABLISHED)"
                    for index in range(1, 5)
                ]
                + [
                    f"node 4242 user 1u IPv4 TCP 127.0.0.1:17551->192.0.2.{index}:21000 (ESTABLISHED)"
                    for index in range(1, 5)
                ]
            )
        elif args[0] == "/fake/ffmpeg" and "framecrc" in args:
            if "0:v:0" in args:
                stdout = video_fixture
            elif "-c:a" in args:
                assert args[args.index("-c:a") + 1] == "copy"
                stdout = audio_packet_fixture
            else:
                stdout = audio_fixture
        elif args[0] == "/fake/ffmpeg":
            stdout = ""
        else:
            raise AssertionError(f"unexpected self-test command: {args[0]}")
        stderr = audio_stderr_fixture if "0:a:0" in args else ""
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr=stderr)

    def fake_framecrc_command(
        args: list[str],
        timeout: float,
    ) -> tuple[subprocess.CompletedProcess[str], list[float]]:
        run = fake_run_command(args, timeout)
        if "0:v:0" in args:
            return run, [0.0, 0.04, 0.08]
        assert "-c:a" not in args, "the authoritative audio health probe must decode AAC"
        return run, [0.0, 0.03]

    globals()["run_command"] = fake_run_command
    globals()["run_framecrc_command"] = fake_framecrc_command
    try:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            diagnostic_log = root / "unifi-direct.log"
            diagnostic_log.write_text(
                "\n".join(
                    f"DS {mac} {track} ready rtsp://127.0.0.1:12345/private-{mac}-{track}"
                    for mac in test_cameras
                    for track in TRACKS
                )
                + "\n"
            )
            args = argparse.Namespace(
                duration=0.25,
                cameras=test_cameras,
                health_interval=60.0,
                startup_interval=60.0,
                deep_interval=60.0,
                deep_seconds=0.01,
                stall_threshold_ms=150.0,
                probe_timeout=1.0,
                log=str(diagnostic_log),
                ffmpeg="/fake/ffmpeg",
                plugin_id="@scrypted/unifi-direct",
                run_dir=str(root / "run"),
            )
            monitor = SoakMonitor(args)
            with diagnostic_log.open("a") as output:
                output.write("DS 020000000001 stream connection dropped; tearing down for rebuild\n")
            diagnostic_log.rename(Path(str(diagnostic_log) + ".1"))
            diagnostic_log.write_text("native media pipeline closed; cleaning up generation\n")
            assert monitor.run() == 0
            summary = json.loads(monitor.summary_path.read_text())
            events_text = monitor.events_path.read_text()
            assert summary["status"] == "complete"
            assert summary["samples"] == {"health": 1, "startup": 1, "deep": 1}
            assert summary["connection_minima"] == {
                "high": 4,
                "medium": 4,
                "total": 8,
                "high_unique_peers": 4,
                "medium_unique_peers": 4,
            }
            assert summary["media_error_markers"]["camera_disconnect"] == 1
            assert summary["media_error_markers"]["pipeline_closed"] == 1
            assert summary["startup"]["failures"] == 0
            assert summary["deep_video"]["probes"] == 8
            assert summary["deep_video"]["arrival_stalls"] == 0
            assert summary["deep_audio"]["probes"] == 4
            assert summary["deep_audio"]["cadence_anomalies"] == 0
            assert summary["deep_audio"]["arrival_stalls"] == 0
            assert summary["deep_audio"]["profiles"] == {"32000Hz/mono": 4}
            assert summary["deep_audio"]["codec_profiles"] == {"aac/LC": 4}
            assert summary["deep_audio"]["aac_object_types"] == {"2": 4}
            assert summary["deep_audio"]["bitrate_bps"] == {
                "samples": 4,
                "min": 128000,
                "median": 128000.0,
                "max": 128000,
            }
            assert summary["deep_audio"]["declared_bitrate_bps"] == {
                "samples": 4,
                "min": 128000,
                "median": 128000.0,
                "max": 128000,
            }
            assert "rtsp://" not in events_text
            assert not monitor.pid_path.exists()
            monitor.append_event("monitor_fatal", error="synthetic-failure")
            assert monitor.build_summary(final=True)["status"] == "failed"

            missing_log = root / "missing.log"
            expected_keys = [(mac, track) for mac in test_cameras for track in TRACKS]
            missing_log.write_text(
                "\n".join(
                    f"DS {mac} {track} ready rtsp://127.0.0.1:12345/missing-test-{mac}-{track}"
                    for mac, track in expected_keys[:-1]
                )
                + "\n"
            )
            missing_args = argparse.Namespace(
                **{
                    **vars(args),
                    "log": str(missing_log),
                    "run_dir": str(root / "missing-run"),
                }
            )
            missing_monitor = SoakMonitor(missing_args)
            missing_monitor.startup_probe()
            missing_monitor.deep_probe()
            missing_summary = missing_monitor.build_summary(final=False)
            assert missing_summary["startup"]["failures"] == 1
            assert missing_summary["deep_video"]["probes"] == 8
            assert missing_summary["deep_video"]["failures"] == 1
            assert "rtsp://" not in missing_monitor.events_path.read_text()

            # Old deep events lack codec/profile/bitrate fields. They must still
            # summarize with the original rate/layout profile and no exceptions.
            legacy_run = root / "legacy-run"
            legacy_run.mkdir()
            legacy_args = argparse.Namespace(**{**vars(args), "run_dir": str(legacy_run)})
            legacy_monitor = SoakMonitor(legacy_args)
            legacy_monitor.append_event(
                "deep",
                video=[],
                audio=[{"camera": "Legacy", "sample_rate": 16000, "channel_layout": "mono", "ok": True}],
            )
            legacy_audio = legacy_monitor.build_summary(final=False)["deep_audio"]
            assert legacy_audio["profiles"] == {"16000Hz/mono": 1}
            assert legacy_audio["codec_profiles"] == {}
            assert legacy_audio["aac_object_types"] == {}
            assert legacy_audio["bitrate_bps"]["samples"] == 0
    finally:
        globals()["run_command"] = original_run_command
        globals()["run_framecrc_command"] = original_framecrc_command
    print("self_test=ok")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--camera",
        action="append",
        default=[],
        type=camera_argument,
        metavar="MAC=LABEL",
        help="expected camera; repeat once per camera (MAC separators are optional)",
    )
    parser.add_argument("--duration", type=float, default=24 * 60 * 60, help="total run duration in seconds")
    parser.add_argument("--health-interval", type=float, default=60, help="seconds between process/log checks")
    parser.add_argument("--startup-interval", type=float, default=15 * 60, help="seconds between all-stream startup probes")
    parser.add_argument("--deep-interval", type=float, default=60 * 60, help="seconds between video/audio frame probes")
    parser.add_argument("--deep-seconds", type=float, default=5, help="media duration of each deep probe")
    parser.add_argument(
        "--stall-threshold-ms",
        type=float,
        default=150,
        help="wall-clock frame delay beyond media cadence that counts as a stall",
    )
    parser.add_argument("--probe-timeout", type=float, default=15, help="per-process timeout")
    parser.add_argument("--log", default="/private/tmp/unifi-direct.log", help="UniFi Direct diagnostic log")
    parser.add_argument("--ffmpeg", default=DEFAULT_FFMPEG)
    parser.add_argument("--plugin-id", default="@scrypted/unifi-direct")
    parser.add_argument("--run-dir", help="persistent result directory (required unless --self-test)")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test and not args.run_dir:
        parser.error("--run-dir is required")
    if not args.self_test and not args.camera:
        parser.error("at least one --camera MAC=LABEL is required")
    cameras = dict(args.camera)
    if len(cameras) != len(args.camera):
        parser.error("camera MACs must be unique")
    if len(set(cameras.values())) != len(cameras):
        parser.error("camera labels must be unique")
    args.cameras = cameras
    for value in (
        args.duration,
        args.health_interval,
        args.startup_interval,
        args.deep_interval,
        args.deep_seconds,
        args.probe_timeout,
        args.stall_threshold_ms,
    ):
        if not math.isfinite(value) or value <= 0:
            parser.error("durations and intervals must be positive")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0
    monitor = SoakMonitor(args)
    signal.signal(signal.SIGTERM, lambda *_: setattr(monitor, "stop_requested", True))
    signal.signal(signal.SIGINT, lambda *_: setattr(monitor, "stop_requested", True))
    try:
        return monitor.run()
    except Exception as error:
        if monitor.pid_acquired:
            try:
                monitor.append_event("monitor_fatal", error=error_category(safe_text(str(error))))
                monitor.write_summary(final=True)
            except Exception:
                pass
        print(f"unifi-soak: {safe_text(str(error))}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
