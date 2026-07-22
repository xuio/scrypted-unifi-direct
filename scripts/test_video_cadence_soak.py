#!/usr/bin/env python3
"""Focused unit and fault-injection tests for video-cadence-soak.py."""

from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("video-cadence-soak.py")
SPEC = importlib.util.spec_from_file_location("video_cadence_soak", SCRIPT)
assert SPEC and SPEC.loader
cadence = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cadence
SPEC.loader.exec_module(cadence)


def packet(
    sequence: int,
    timestamp: int,
    payload: bytes = b"\x41\x01",
    *,
    marker: bool = True,
    payload_type: int = 96,
    ssrc: int = 0x10203040,
) -> bytes:
    return cadence.make_test_rtp(
        sequence,
        timestamp,
        payload,
        marker=marker,
        payload_type=payload_type,
        ssrc=ssrc,
    )


def analyzer(limit: int = 32, start_ns: int = 0, end_ns: int = 10_000_000_000):
    value = cadence.VideoCadenceAnalyzer("test", anomaly_limit=limit)
    value.configure_window(start_ns, end_ns)
    return value


def audio_analyzer(
    limit: int = 32,
    start_ns: int = 0,
    end_ns: int = 10_000_000_000,
    codec: str = "opus",
):
    value = cadence.AudioCadenceAnalyzer("test-audio", anomaly_limit=limit)
    if codec == "opus":
        track = cadence.AudioTrack(97, "trackID=1", "opus", 48_000, 1, 2, 20.0)
    else:
        track = cadence.AudioTrack(97, "trackID=1", "aac", 32_000, 1, 1, None)
    value.configure_track(track)
    value.configure_window(start_ns, end_ns)
    return value


def audio_packet(
    sequence: int,
    timestamp: int,
    payload: bytes = b"\xf8\x00",
    *,
    ssrc: int = 0x50607080,
) -> bytes:
    return packet(
        sequence,
        timestamp,
        payload,
        marker=False,
        payload_type=97,
        ssrc=ssrc,
    )


class RtpParsingTests(unittest.TestCase):
    def test_parse_rtp_supports_csrc_extension_and_padding(self) -> None:
        raw = bytearray(12)
        raw[0] = 0x80 | 0x20 | 0x10 | 1  # padding, extension, one CSRC
        raw[1] = 0x80 | 103
        raw[2:4] = (65535).to_bytes(2, "big")
        raw[4:8] = (0xFFFFFF00).to_bytes(4, "big")
        raw[8:12] = (7).to_bytes(4, "big")
        raw.extend((8).to_bytes(4, "big"))  # CSRC
        raw.extend(b"\x10\x00\x00\x01")  # extension header, one word
        raw.extend(b"abcd")
        raw.extend(b"\x41payload")
        raw.extend(b"\x00\x02")
        parsed = cadence.parse_rtp(bytes(raw))
        self.assertIsNotNone(parsed)
        assert parsed
        self.assertEqual(parsed.payload_type, 103)
        self.assertTrue(parsed.marker)
        self.assertEqual(parsed.sequence, 65535)
        self.assertEqual(parsed.timestamp, 0xFFFFFF00)
        self.assertEqual(parsed.payload, b"\x41payload")

    def test_parse_rtp_rejects_bad_padding_and_truncation(self) -> None:
        self.assertIsNone(cadence.parse_rtp(b"short"))
        raw = bytearray(packet(1, 1))
        raw[0] |= 0x20
        raw[-1] = 255
        self.assertIsNone(cadence.parse_rtp(bytes(raw)))

    def test_video_sdp_selects_h264_track(self) -> None:
        payload_type, control = cadence.parse_video_sdp(
            "v=0\r\n"
            "m=audio 0 RTP/AVP 97\r\n"
            "a=rtpmap:97 opus/48000/2\r\n"
            "a=control:trackID=1\r\n"
            "m=video 0 RTP/AVP 102 96\r\n"
            "a=rtpmap:102 VP8/90000\r\n"
            "a=rtpmap:96 H264/90000\r\n"
            "a=control:trackID=0\r\n"
        )
        self.assertEqual((payload_type, control), (96, "trackID=0"))

    def test_sdp_prefers_and_validates_standards_compliant_mono_opus(self) -> None:
        tracks = cadence.parse_sdp_tracks(
            "v=0\r\n"
            "m=video 0 RTP/AVP 96\r\n"
            "a=rtpmap:96 H264/90000\r\n"
            "a=control:trackID=0\r\n"
            "m=audio 0 RTP/AVP 98 97\r\n"
            "a=rtpmap:98 MPEG4-GENERIC/32000/1\r\n"
            "a=rtpmap:97 opus/48000/2\r\n"
            "a=fmtp:97 stereo=0;sprop-stereo=0;cbr=1\r\n"
            "a=ptime:20\r\n"
            "a=control:trackID=1\r\n"
        )
        self.assertEqual(tracks.video_payload_type, 96)
        self.assertEqual(tracks.audio.codec, "opus")
        self.assertEqual(tracks.audio.clock_rate, 48_000)
        self.assertEqual(tracks.audio.channels, 1)
        self.assertEqual(tracks.audio.rtpmap_channels, 2)
        self.assertEqual(tracks.audio.frame_duration_ms, 20.0)

        invalid = (
            "v=0\r\n"
            "m=video 0 RTP/AVP 96\r\n"
            "a=rtpmap:96 H264/90000\r\n"
            "a=control:trackID=0\r\n"
            "m=audio 0 RTP/AVP 97\r\n"
            "a=rtpmap:97 opus/44100/2\r\n"
            "a=control:trackID=1\r\n"
        )
        with self.assertRaisesRegex(ValueError, "48000"):
            cadence.parse_sdp_tracks(invalid)

    def test_sdp_explicitly_recognizes_aac_when_opus_is_absent(self) -> None:
        tracks = cadence.parse_sdp_tracks(
            "v=0\r\n"
            "m=video 0 RTP/AVP 96\r\n"
            "a=rtpmap:96 H264/90000\r\n"
            "a=control:trackID=0\r\n"
            "m=audio 0 RTP/AVP 98\r\n"
            "a=rtpmap:98 MPEG4-GENERIC/32000/1\r\n"
            "a=fmtp:98 mode=AAC-hbr\r\n"
            "a=control:trackID=1\r\n"
        )
        self.assertEqual(tracks.audio.codec, "aac")
        self.assertEqual(tracks.audio.clock_rate, 32_000)
        self.assertEqual(tracks.audio.channels, 1)

    def test_rtcp_sender_report_parser_accepts_compound_and_rejects_truncation(self) -> None:
        first = cadence.make_test_rtcp_sr(7, 3_900_000_000.25, 90_000)
        second = cadence.make_test_rtcp_sr(8, 3_900_000_000.5, 48_000)
        reports = cadence.parse_rtcp_sender_reports(first + second)
        self.assertIsNotNone(reports)
        assert reports is not None
        self.assertEqual([(item.ssrc, item.rtp_timestamp) for item in reports], [
            (7, 90_000),
            (8, 48_000),
        ])
        self.assertAlmostEqual(reports[0].ntp_seconds, 3_900_000_000.25, places=6)
        self.assertIsNone(cadence.parse_rtcp_sender_reports(first[:-1]))

    def test_safe_log_discovery_prefers_latest_active_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "unifi-direct.log"
            Path(str(log) + ".1").write_text(
                "DS 1C6A1BFFAA3C video1 ready rtsp://127.0.0.1:1/old-high\n"
                "DS 1C6A1BFFAA3C video2 ready rtsp://127.0.0.1:2/old-medium\n"
            )
            log.write_text(
                "DS 000000000001 video1 ready rtsp://127.0.0.1:3/not-this-camera\n"
                "DS 1C6A1BFFAA3C video1 ready rtsp://127.0.0.1:4/new-high-token\n"
                "DS 1C6A1BFFAA3C video2 ready rtsp://127.0.0.1:5/new-medium-token\n"
            )
            found = cadence.discover_urls(str(log), "1c:6a:1b:ff:aa:3c")
            self.assertEqual(found, {
                "high": "rtsp://127.0.0.1:4/new-high-token",
                "medium": "rtsp://127.0.0.1:5/new-medium-token",
            })

    def test_safe_log_discovery_requires_both_tracks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "unifi-direct.log"
            log.write_text("DS 1C6A1BFFAA3C video1 ready rtsp://127.0.0.1:1/high\n")
            with self.assertRaisesRegex(ValueError, "video2"):
                cadence.discover_urls(str(log), "1C6A1BFFAA3C")


class FakeRtspServer:
    """Minimal loopback H.264+Opus+RTCP source for the command-path test."""

    def __init__(self, timestamp_base: int) -> None:
        self.timestamp_base = timestamp_base
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.stop = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    @staticmethod
    def _request(connection: socket.socket, buffered: bytearray) -> str:
        while b"\r\n\r\n" not in buffered:
            data = connection.recv(4096)
            if not data:
                raise ConnectionError("test client closed")
            buffered.extend(data)
        end = buffered.index(b"\r\n\r\n")
        request = bytes(buffered[:end]).decode("ascii")
        del buffered[:end + 4]
        return request

    @staticmethod
    def _reply(connection: socket.socket, cseq: str, headers=(), body=b"") -> None:
        lines = ["RTSP/1.0 200 OK", f"CSeq: {cseq}", *headers]
        connection.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body)

    @staticmethod
    def _interleaved(connection: socket.socket, channel: int, payload: bytes) -> None:
        connection.sendall(b"$" + bytes([channel]) + len(payload).to_bytes(2, "big") + payload)

    def _run(self) -> None:
        connection = None
        try:
            connection, _ = self.listener.accept()
            buffered = bytearray()
            setup_number = 0
            for expected in ("DESCRIBE", "SETUP", "SETUP", "PLAY"):
                request = self._request(connection, buffered)
                lines = request.split("\r\n")
                self.assert_method(lines[0], expected)
                cseq = next(line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("cseq:"))
                if expected == "DESCRIBE":
                    body = (
                        "v=0\r\n"
                        "m=video 0 RTP/AVP 96\r\n"
                        "a=rtpmap:96 H264/90000\r\n"
                        "a=control:trackID=0\r\n"
                        "m=audio 0 RTP/AVP 97\r\n"
                        "a=rtpmap:97 opus/48000/2\r\n"
                        "a=fmtp:97 stereo=0;sprop-stereo=0;cbr=1\r\n"
                        "a=ptime:20\r\n"
                        "a=control:trackID=1\r\n"
                    ).encode("ascii")
                    self._reply(
                        connection,
                        cseq,
                        (
                            f"Content-Base: rtsp://127.0.0.1:{self.port}/secret-token/",
                            "Content-Type: application/sdp",
                            f"Content-Length: {len(body)}",
                        ),
                        body,
                    )
                elif expected == "SETUP":
                    requested_channels = "0-1" if setup_number == 0 else "2-3"
                    if f"interleaved={requested_channels}" not in request:
                        raise AssertionError("client requested wrong interleaved channels")
                    self._reply(
                        connection,
                        cseq,
                        (
                            "Session: test-session",
                            f"Transport: RTP/AVP/TCP;unicast;interleaved={requested_channels}",
                        ),
                    )
                    setup_number += 1
                else:
                    self._reply(connection, cseq, ("Session: test-session",))

            video_sequence = 0
            audio_sequence = 0
            video_timestamp = self.timestamp_base
            audio_timestamp = (self.timestamp_base * 7) & 0xFFFFFFFF
            video_elapsed = 0
            audio_elapsed = 0
            next_video = time.monotonic()
            next_audio = next_video
            ntp_base = 3_900_000_000.0
            while not self.stop.is_set():
                now = time.monotonic()
                if now >= next_video:
                    video = packet(video_sequence, video_timestamp)
                    self._interleaved(connection, 0, video)
                    self._interleaved(
                        connection,
                        1,
                        cadence.make_test_rtcp_sr(
                            0x10203040,
                            ntp_base + video_elapsed / 90_000,
                            video_timestamp,
                        ),
                    )
                    video_sequence = (video_sequence + 1) & 0xFFFF
                    delta = 3060 if video_sequence % 3 == 0 else 2970
                    video_timestamp = (video_timestamp + delta) & 0xFFFFFFFF
                    video_elapsed += delta
                    next_video += delta / 90_000
                if now >= next_audio:
                    audio = audio_packet(audio_sequence, audio_timestamp)
                    self._interleaved(connection, 2, audio)
                    self._interleaved(
                        connection,
                        3,
                        cadence.make_test_rtcp_sr(
                            0x50607080,
                            ntp_base + audio_elapsed / 48_000,
                            audio_timestamp,
                        ),
                    )
                    audio_sequence = (audio_sequence + 1) & 0xFFFF
                    audio_timestamp = (audio_timestamp + 960) & 0xFFFFFFFF
                    audio_elapsed += 960
                    next_audio += 0.020
                time.sleep(max(0.0005, min(next_video, next_audio) - time.monotonic()))
        except (BrokenPipeError, ConnectionError, OSError):
            # The validator closes both clients at the shared deadline before
            # the test harness asks the fake sources to stop.
            pass
        except Exception as error:  # pragma: no cover - surfaced by the assertion below
            self.error = str(error)
        finally:
            if connection:
                try:
                    connection.close()
                except OSError:
                    pass
            self.listener.close()

    @staticmethod
    def assert_method(request_line: str, expected: str) -> None:
        if not request_line.startswith(expected + " "):
            raise AssertionError(f"expected {expected}, got {request_line}")

    def close(self) -> None:
        self.stop.set()
        try:
            self.listener.close()
        except OSError:
            pass
        self.thread.join(timeout=2)


class CommandPathTests(unittest.TestCase):
    def test_two_rtsp_sources_run_in_one_bounded_window_without_leaking_urls(self) -> None:
        servers = (FakeRtspServer(1000), FakeRtspServer(2000))
        for server in servers:
            server.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "report.json"
                args = SimpleNamespace(
                    output=str(output),
                    high_url=f"rtsp://user:password@127.0.0.1:{servers[0].port}/secret-token",
                    high_url_file=None,
                    medium_url=f"rtsp://user:password@127.0.0.1:{servers[1].port}/secret-token",
                    medium_url_file=None,
                    discover_log=None,
                    camera_mac="1c:6a:1b:ff:aa:3c",
                    firmware_sha256="a" * 64,
                    plugin_sha256="b" * 64,
                    source_sha256="c" * 64,
                    duration=0.15,
                    startup_exclusion=0.02,
                    wall_gap_ms=200.0,
                    minimum_fps=1.0,
                    maximum_fps=200.0,
                    anomaly_limit=4,
                    connect_timeout=1.0,
                    keepalive_interval=10.0,
                    report_interval=1.0,
                    insecure_tls=False,
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cadence.run(args), 0)
                report_text = output.read_text()
                report = json.loads(report_text)
                self.assertEqual(report["schema"], 2)
                self.assertEqual(report["verdict"], "pass")
                self.assertEqual(set(report["streams"]), {"high", "medium"})
                self.assertEqual(report["provenance"]["requested_camera_mac"], "1C6A1BFFAA3C")
                self.assertEqual(report["provenance"]["firmware_sha256"], "a" * 64)
                self.assertRegex(report["provenance"]["validator_sha256"], r"^[0-9a-f]{64}$")
                for stream in report["streams"].values():
                    self.assertEqual(stream["audio"]["profile"]["codec"], "opus")
                    self.assertGreater(stream["audio"]["packets"]["clean"], 1)
                    self.assertTrue(stream["av_sync"]["standards_compliant_mappings_observed"])
                    self.assertEqual(stream["av_sync"]["drift_over_threshold"], 0)
                self.assertNotIn("password", report_text)
                self.assertNotIn("secret-token", report_text)
        finally:
            for server in servers:
                server.close()
            self.assertEqual([server.error for server in servers], [None, None])


class AudioCadenceTests(unittest.TestCase):
    def test_opus_wrap_safe_plus_960_and_20ms_packets_are_clean(self) -> None:
        value = audio_analyzer()
        base = 0xFFFFFC80
        value.consume_rtp(audio_packet(65535, base), 0)  # excluded baseline
        value.consume_rtp(audio_packet(0, (base + 960) & 0xFFFFFFFF), 20_000_000)
        value.consume_rtp(audio_packet(1, (base + 1920) & 0xFFFFFFFF), 40_000_000)
        result = value.snapshot()
        self.assertEqual(result["packets"], {
            "total": 2,
            "clean": 2,
            "with_violations": 0,
        })
        self.assertEqual(result["sequence_wraps"], 1)
        self.assertEqual(result["timestamp_wraps"], 1)
        self.assertEqual(result["timestamp_delta_ticks"]["min"], 960)
        self.assertEqual(result["timestamp_delta_ticks"]["max"], 960)
        self.assertEqual(result["anomalies_total"], 0)

    def test_opus_loss_timestamp_duration_and_wall_faults_trip_gates(self) -> None:
        value = audio_analyzer()
        value.consume_rtp(audio_packet(10, 1000), 0)
        # Skip packets and use a 10 ms TOC while arriving after the 40 ms gate.
        value.consume_rtp(audio_packet(13, 3880, b"\xf0\x00"), 60_000_000)
        value.consume_rtp(audio_packet(14, 4840), 80_000_000)
        audio_result = value.snapshot()
        counts = audio_result["anomaly_counts"]
        self.assertEqual(counts["sequence_gap"], 1)
        self.assertEqual(counts["opus_timestamp_delta_unexpected"], 1)
        self.assertEqual(counts["opus_timestamp_gap_gt_40ms"], 1)
        self.assertEqual(counts["opus_wall_gap_gt_40ms"], 1)
        self.assertEqual(counts["opus_packet_duration_unexpected"], 1)
        video = analyzer()
        video.consume_rtp(packet(1, 1000), 0)
        video.consume_rtp(packet(2, 3970), 33_000_000)
        video.consume_rtp(packet(3, 7030), 67_000_000)
        combined = video.snapshot()
        combined["audio"] = audio_result
        failures = cadence.evaluate_stream(
            combined,
            requested_seconds=0.06,
            minimum_fps=1,
            maximum_fps=100,
        )
        self.assertTrue(any("audio sequence_gap" in failure for failure in failures))

    def test_audio_duplicate_and_reorder_do_not_create_a_fictitious_next_gap(self) -> None:
        value = audio_analyzer()
        value.consume_rtp(audio_packet(100, 0), 0)
        value.consume_rtp(audio_packet(101, 960), 20_000_000)
        value.consume_rtp(audio_packet(101, 960), 21_000_000)
        value.consume_rtp(audio_packet(100, 0), 22_000_000)
        value.consume_rtp(audio_packet(102, 1920), 40_000_000)
        counts = value.snapshot()["anomaly_counts"]
        self.assertEqual(counts["sequence_duplicate"], 1)
        self.assertEqual(counts["sequence_reordered"], 1)
        self.assertEqual(counts["sequence_gap"], 0)

    def test_audio_ssrc_and_rtcp_faults_are_reported(self) -> None:
        value = audio_analyzer()
        value.consume_rtp(audio_packet(1, 0), 0)
        value.consume_rtp(audio_packet(2, 960, ssrc=9), 20_000_000)
        value.consume_rtcp(cadence.make_test_rtcp_sr(9, 1000.0, 960), 21_000_000)
        value.consume_rtcp(cadence.make_test_rtcp_sr(10, 1000.0, 960), 22_000_000)
        value.consume_rtcp(b"bad", 23_000_000)
        result = value.snapshot()
        self.assertEqual(result["anomaly_counts"]["ssrc_change"], 1)
        self.assertEqual(result["anomaly_counts"]["rtcp_sr_ssrc_mismatch"], 1)
        self.assertEqual(result["anomaly_counts"]["invalid_rtcp"], 1)
        self.assertEqual(result["rtcp_packets"], 3)
        self.assertEqual(result["rtcp_sender_reports"], 1)

    def test_aac_is_explicitly_recognized_without_opus_specific_false_alarms(self) -> None:
        value = audio_analyzer(codec="aac")
        value.consume_rtp(audio_packet(1, 0, b"aac"), 0)
        value.consume_rtp(audio_packet(2, 1024, b"aac"), 64_000_000)
        result = value.snapshot()
        self.assertEqual(result["profile"]["codec"], "aac")
        self.assertEqual(result["packets"]["clean"], 1)
        self.assertEqual(result["anomalies_total"], 0)

    def test_acceptance_requires_advertised_opus_profile_and_rtcp_av_mapping(self) -> None:
        video = analyzer()
        video.consume_rtp(packet(1, 1000), 0)
        video.consume_rtp(packet(2, 3970), 33_000_000)
        video.consume_rtp(packet(3, 7030), 67_000_000)
        audio = audio_analyzer(codec="aac")
        audio.consume_rtp(audio_packet(1, 0, b"aac"), 0)
        audio.consume_rtp(audio_packet(2, 1024, b"aac"), 32_000_000)
        audio.consume_rtp(audio_packet(3, 2048, b"aac"), 64_000_000)
        combined = video.snapshot()
        combined["audio"] = audio.snapshot()
        combined["av_sync"] = cadence.AvSyncAnalyzer(anomaly_limit=2).snapshot()

        failures = cadence.evaluate_stream(
            combined,
            requested_seconds=0.04,
            minimum_fps=1,
            maximum_fps=100,
        )
        self.assertTrue(any("mono Opus/48000 with 20 ms frames" in failure for failure in failures))
        self.assertTrue(any("no standards-compliant RTCP" in failure for failure in failures))


class AvSyncTests(unittest.TestCase):
    @staticmethod
    def _rtp(sequence, timestamp, payload_type, ssrc):
        parsed = cadence.parse_rtp(packet(
            sequence,
            timestamp,
            payload=b"\x41x" if payload_type == 96 else b"\xf8x",
            payload_type=payload_type,
            ssrc=ssrc,
        ))
        assert parsed is not None
        return parsed

    def test_sender_report_mappings_measure_normal_av_alignment(self) -> None:
        sync = cadence.AvSyncAnalyzer(anomaly_limit=4)
        sync.configure_audio(cadence.AudioTrack(97, "trackID=1", "opus", 48_000, 1, 2, 20.0))
        sync.configure_window(0, 1_000_000_000)
        video_ssrc, audio_ssrc = 7, 8
        sync.note_rtp("video", self._rtp(1, 90_000, 96, video_ssrc), 0)
        sync.note_rtp("audio", self._rtp(1, 48_000, 97, audio_ssrc), 0)
        sync.note_sender_reports(
            "video",
            [cadence.RtcpSenderReport(video_ssrc, 1000.0, 90_000)],
            1,
        )
        sync.note_sender_reports(
            "audio",
            [cadence.RtcpSenderReport(audio_ssrc, 1000.0, 48_000)],
            1,
        )
        sync.note_rtp("audio", self._rtp(2, 48_960, 97, audio_ssrc), 20_000_000)
        sync.note_rtp("video", self._rtp(2, 92_970, 96, video_ssrc), 33_000_000)
        result = sync.snapshot()
        self.assertTrue(result["standards_compliant_mappings_observed"])
        self.assertGreaterEqual(result["samples"], 3)
        self.assertEqual(result["drift_over_threshold"], 0)
        self.assertLessEqual(result["absolute_drift_ms"]["max"], 20.0)

    def test_sender_report_offset_injects_and_gates_av_drift(self) -> None:
        sync = cadence.AvSyncAnalyzer(anomaly_limit=2)
        sync.configure_audio(cadence.AudioTrack(97, "trackID=1", "opus", 48_000, 1, 2, 20.0))
        sync.configure_window(0, 1_000_000_000)
        sync.note_rtp("video", self._rtp(1, 90_000, 96, 7), 0)
        sync.note_rtp("audio", self._rtp(1, 48_000, 97, 8), 0)
        sync.note_sender_reports("video", [cadence.RtcpSenderReport(7, 1000.0, 90_000)], 1)
        sync.note_sender_reports("audio", [cadence.RtcpSenderReport(8, 1000.075, 48_000)], 1)
        result = sync.snapshot()
        self.assertEqual(result["drift_over_threshold"], 1)
        self.assertAlmostEqual(result["absolute_drift_ms"]["max"], 75.0, places=3)
        self.assertEqual(result["anomalies"][0]["kind"], "av_drift_gt_40ms")

        video = analyzer()
        video.consume_rtp(packet(1, 1000), 0)
        video.consume_rtp(packet(2, 3970), 33_000_000)
        video.consume_rtp(packet(3, 7030), 67_000_000)
        audio = audio_analyzer()
        audio.consume_rtp(audio_packet(1, 0), 0)
        audio.consume_rtp(audio_packet(2, 960), 20_000_000)
        audio.consume_rtp(audio_packet(3, 1920), 40_000_000)
        combined = video.snapshot()
        combined["audio"] = audio.snapshot()
        combined["av_sync"] = result
        failures = cadence.evaluate_stream(
            combined,
            requested_seconds=0.04,
            minimum_fps=1,
            maximum_fps=100,
        )
        self.assertTrue(any("A/V drift" in failure for failure in failures))


class CadenceTests(unittest.TestCase):
    def test_wrap_safe_sequence_and_timestamp_cadence(self) -> None:
        value = analyzer()
        base = 0xFFFFF800
        value.consume_rtp(packet(65535, base), 0)  # excluded baseline
        value.consume_rtp(packet(0, (base + 2970) & 0xFFFFFFFF), 33_000_000)
        value.consume_rtp(packet(1, (base + 6030) & 0xFFFFFFFF), 67_000_000)
        result = value.snapshot()
        self.assertEqual(result["aus"], {
            "total": 2,
            "clean": 2,
            "with_violations": 0,
            "malformed": 0,
            "cadence_or_transport_violations": 0,
            "idr": 0,
            "vcl_nals": 2,
        })
        self.assertEqual(result["anomalies_total"], 0)
        self.assertEqual(result["sequence_wraps"], 1)
        self.assertEqual(result["timestamp_wraps"], 1)
        self.assertEqual(result["timestamp_delta_histogram"]["2970"], 1)
        self.assertEqual(result["timestamp_delta_histogram"]["3060"], 1)

    def test_startup_exclusion_waits_for_a_complete_boundary_au(self) -> None:
        value = analyzer(start_ns=1_000_000_000)
        value.consume_rtp(b"bad", 100_000_000)
        value.consume_rtp(packet(1, 1000, marker=False), 900_000_000)
        value.consume_rtp(packet(2, 1000), 1_010_000_000)  # boundary AU marker
        value.consume_rtp(packet(3, 3970), 1_043_000_000)
        result = value.snapshot()
        self.assertEqual(result["startup_packets_excluded"], 3)
        self.assertEqual(result["startup_boundary_aus_excluded"], 1)
        self.assertEqual(result["aus"]["clean"], 1)
        self.assertEqual(result["anomalies_total"], 0)

    def test_missing_frame_fault_trips_all_relevant_gates(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(10, 1000), 0)
        value.consume_rtp(packet(12, 7030), 67_000_000)
        result = value.snapshot()
        counts = result["anomaly_counts"]
        self.assertEqual(counts["sequence_gap"], 1)
        self.assertEqual(counts["timestamp_delta_unexpected"], 1)
        self.assertEqual(counts["timestamp_gap_gt_40ms"], 1)
        self.assertEqual(counts["wall_gap_gt_threshold"], 1)
        self.assertEqual(result["aus"]["malformed"], 0)
        self.assertEqual(result["aus"]["cadence_or_transport_violations"], 1)

    def test_unexpected_3000_tick_delta_fails_without_being_a_40ms_gap(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(1, 10_000), 0)
        value.consume_rtp(packet(2, 13_000), 33_333_333)
        counts = value.snapshot()["anomaly_counts"]
        self.assertEqual(counts["timestamp_delta_unexpected"], 1)
        self.assertEqual(counts["timestamp_gap_gt_40ms"], 0)

    def test_wall_gap_threshold_is_strictly_greater_than_40ms(self) -> None:
        at_40 = analyzer()
        at_40.consume_rtp(packet(1, 1000), 0)
        at_40.consume_rtp(packet(2, 3970), 40_000_000)
        self.assertEqual(at_40.snapshot()["anomaly_counts"]["wall_gap_gt_threshold"], 0)

        above_40 = analyzer()
        above_40.consume_rtp(packet(1, 1000), 0)
        above_40.consume_rtp(packet(2, 3970), 40_000_001)
        self.assertEqual(above_40.snapshot()["anomaly_counts"]["wall_gap_gt_threshold"], 1)

    def test_orphan_fu_and_unterminated_fu_are_structurally_malformed(self) -> None:
        orphan = analyzer()
        orphan.consume_rtp(packet(1, 1000), 0)
        orphan.consume_rtp(packet(2, 3970, b"\x5c\x45x"), 33_000_000)
        result = orphan.snapshot()
        self.assertGreaterEqual(result["anomaly_counts"]["fu_invalid"], 1)
        self.assertEqual(result["aus"]["malformed"], 1)

        unterminated = analyzer()
        unterminated.consume_rtp(packet(1, 1000), 0)
        unterminated.consume_rtp(packet(2, 3970, b"\x5c\x81x", marker=True), 33_000_000)
        result = unterminated.snapshot()
        self.assertGreaterEqual(result["anomaly_counts"]["fu_invalid"], 1)
        self.assertEqual(result["aus"]["malformed"], 1)

    def test_valid_fragmented_idr_is_one_valid_au(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(1, 1000), 0)
        value.consume_rtp(packet(2, 3970, b"\x5c\x85first", marker=False), 30_000_000)
        value.consume_rtp(packet(3, 3970, b"\x5c\x45last"), 33_000_000)
        result = value.snapshot()
        self.assertEqual(result["aus"]["clean"], 1)
        self.assertEqual(result["aus"]["idr"], 1)
        self.assertEqual(result["anomalies_total"], 0)

    def test_timestamp_change_before_marker_is_not_concealed(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(1, 1000), 0)
        value.consume_rtp(packet(2, 3970, marker=False), 33_000_000)
        value.consume_rtp(packet(3, 7030), 67_000_000)
        result = value.snapshot()
        self.assertEqual(result["anomaly_counts"]["au_missing_marker"], 1)
        self.assertGreaterEqual(result["aus"]["malformed"], 1)

    def test_ssrc_change_duplicate_and_reorder_are_reported(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(100, 1000), 0)
        value.consume_rtp(packet(100, 3970), 33_000_000)
        value.consume_rtp(packet(99, 7030), 67_000_000)
        value.consume_rtp(packet(100, 10_000, ssrc=9), 100_000_000)
        counts = value.snapshot()["anomaly_counts"]
        self.assertEqual(counts["sequence_duplicate"], 1)
        self.assertEqual(counts["sequence_reordered"], 1)
        self.assertEqual(counts["ssrc_change"], 1)
        self.assertEqual(counts["sequence_gap"], 0)

    def test_video_duplicate_and_reorder_do_not_advance_sequence_baseline(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(100, 1000), 0)
        value.consume_rtp(packet(101, 3970), 33_000_000)
        value.consume_rtp(packet(101, 3970), 34_000_000)
        value.consume_rtp(packet(100, 1000), 35_000_000)
        value.consume_rtp(packet(102, 7030), 67_000_000)
        counts = value.snapshot()["anomaly_counts"]
        self.assertEqual(counts["sequence_duplicate"], 1)
        self.assertEqual(counts["sequence_reordered"], 1)
        self.assertEqual(counts["sequence_gap"], 0)

    def test_anomaly_ring_remains_fixed_size(self) -> None:
        value = analyzer(limit=3)
        value.consume_rtp(packet(1, 1000), 0)
        sequence = 1
        timestamp = 1000
        wall = 0
        for _ in range(100):
            sequence += 2
            timestamp += 6030
            wall += 67_000_000
            value.consume_rtp(packet(sequence, timestamp), wall)
        result = value.snapshot()
        self.assertEqual(result["anomalies_retained"], 3)
        self.assertGreater(result["anomalies_evicted"], 300)
        self.assertEqual(len(result["anomalies"]), 3)

    def test_two_analyzers_can_be_driven_concurrently(self) -> None:
        values = {label: analyzer() for label in ("high", "medium")}
        barrier = threading.Barrier(2)

        def feed(value, base):
            value.consume_rtp(packet(1, base), 0)
            barrier.wait()
            for index in range(1, 101):
                delta = 2970 if index % 3 else 3060
                base = (base + delta) & 0xFFFFFFFF
                value.consume_rtp(packet(index + 1, base), index * 33_500_000)

        threads = [
            threading.Thread(target=feed, args=(values["high"], 1000)),
            threading.Thread(target=feed, args=(values["medium"], 2000)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        for value in values.values():
            result = value.snapshot()
            self.assertEqual(result["aus"]["clean"], 100)
            self.assertEqual(result["anomalies_total"], 0)

    def test_evaluation_produces_an_explicit_failure(self) -> None:
        value = analyzer()
        value.consume_rtp(packet(1, 1000), 0)
        value.consume_rtp(packet(3, 7030), 67_000_000)
        failures = cadence.evaluate_stream(
            value.snapshot(),
            requested_seconds=0.067,
            minimum_fps=1,
            maximum_fps=100,
        )
        self.assertTrue(any("sequence_gap" in failure for failure in failures))
        self.assertTrue(any("timestamp_gap_gt_40ms" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
